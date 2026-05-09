import type { PendingActionStatus } from "@prisma/client";

import prisma from "../../db.server";
import { isApprovalRequiredWrite } from "./tool-classifier";
import type { ContentBlock } from "./translate.server";
import { log } from "../log.server";

// V2.2 — Learning Foundation. The classifier inspects an assistant turn's
// content blocks plus the terminal status of each PendingAction it spawned
// and returns a single outcome label. The writer persists the row.
//
// "rephrased" / "abandoned" are NOT decided here — they need to know what
// the merchant did NEXT. That's the reclassifier's job
// (turn-signals-reclassify.server.ts), which runs at the start of each new
// turn and at startup as a one-shot sweep.

export type TurnOutcome =
  | "approved" // any approval-required write reached EXECUTED
  | "rejected" // any approval-required write reached REJECTED (and none EXECUTED)
  | "clarified" // CEO called ask_clarifying_question
  | "rephrased" // (deferred) next user turn within 60s started with "no", "actually", "I meant", …
  | "abandoned" // (deferred) no next user turn within 24h AND no terminal write
  | "informational"; // pure read / question-answer turn

export type ClassifierInput = {
  assistantContent: ContentBlock[];
  pendingActions: { toolCallId: string; status: PendingActionStatus }[];
};

// Pure function — takes the assistant turn's blocks plus the terminal
// PendingAction statuses for this turn's writes, returns an outcome.
//
// Priority order (matters when multiple signals are present):
//   1. EXECUTED → "approved"  — successful writes are the strongest signal.
//   2. Clarification call (regardless of writes — ask_clarifying_question
//      breaks the loop, so writes can't co-occur in practice anyway).
//   3. REJECTED / FAILED → "rejected"  — at least one write was declined.
//   4. PENDING / no writes → "informational".
export function classifyTurnOutcome(input: ClassifierInput): TurnOutcome {
  const { assistantContent, pendingActions } = input;

  const calledClarification = assistantContent.some(
    (b) => b.type === "tool_use" && b.name === "ask_clarifying_question",
  );

  // Approved writes win even if a clarification was somehow also asked
  // (defensive — the agent loop breaks before that combo can happen).
  const anyExecuted = pendingActions.some((p) => p.status === "EXECUTED");
  if (anyExecuted) return "approved";

  if (calledClarification) return "clarified";

  const writeBlocks = assistantContent.filter(
    (b) => b.type === "tool_use" && isApprovalRequiredWrite(b.name),
  );
  if (writeBlocks.length > 0) {
    const terminallyDeclined = pendingActions.some(
      (p) => p.status === "REJECTED" || p.status === "FAILED",
    );
    if (terminallyDeclined) return "rejected";
    // Writes exist but are still PENDING (approval card showing) — at
    // SSE-done time we treat that as informational; the reclassifier may
    // promote it to abandoned if the merchant walks away.
  }

  return "informational";
}

// Counts the tool_use blocks in the assistant content. Used as TurnSignal
// metadata so the admin view can show "this turn fired N tools" at a
// glance.
export function countToolCalls(assistantContent: ContentBlock[]): number {
  let n = 0;
  for (const b of assistantContent) {
    if (b.type === "tool_use") n++;
  }
  return n;
}

export function hasWriteToolCall(assistantContent: ContentBlock[]): boolean {
  for (const b of assistantContent) {
    if (b.type === "tool_use" && isApprovalRequiredWrite(b.name)) return true;
  }
  return false;
}

export function hasClarificationCall(assistantContent: ContentBlock[]): boolean {
  for (const b of assistantContent) {
    if (b.type === "tool_use" && b.name === "ask_clarifying_question") return true;
  }
  return false;
}

// V6.2 — Phase 6.2 Confidence Calibration. Pure parser: scan the assistant
// text for `Confidence: 0.X` tags (per output-format.md), return the highest
// value seen this turn, clamped to [0, 1]. Returns null when no tag is
// present — most informational turns won't have one (greetings, lookups,
// confirmations after a successful tool ran).
//
// The CEO is instructed to render the tag on its own italic line at the end
// of a recommendation:
//   *Confidence: 0.6 — based on 30-day analytics.*
//
// We accept both `0.6` and `.6`, ignore the rest of the line, and tolerate
// surrounding markdown (italics, bold, parentheses) so a slight rendering
// drift doesn't lose the signal. Case-insensitive on the literal "Confidence".
export function extractMaxConfidence(text: string): number | null {
  if (!text || text.length === 0) return null;
  // Match optional surrounding * or _ (italics/bold) before "Confidence",
  // then the number. Bare \d+(?:\.\d+)? captures both `0.6` and integer
  // forms like `1` (which we'll clamp/cap appropriately).
  const re = /confidence\s*:\s*(\d+(?:\.\d+)?|\.\d+)/gi;
  let max: number | null = null;
  for (const m of text.matchAll(re)) {
    const raw = parseFloat(m[1]);
    if (!Number.isFinite(raw)) continue;
    // Clamp to [0, 1]. Discard nonsense values (e.g. the CEO writing
    // "Confidence: 95" intending 95% — that's a 0.95 in our scale, but
    // we don't try to reinterpret; we clamp to 1.0 and trust the prompt
    // to teach the format. False positives this catches: the CEO
    // accidentally writing "Confidence: 5" meaning "5/10" — clamp keeps
    // the row from being garbage.
    const clamped = Math.max(0, Math.min(1, raw));
    if (max === null || clamped > max) max = clamped;
  }
  return max;
}

export type RecordTurnSignalInput = {
  storeId: string;
  conversationId: string;
  messageId: string;
  outcome: TurnOutcome;
  toolCalls: number;
  hadWriteTool: boolean;
  hadClarification: boolean;
  hadPlan?: boolean;
  latencyMs?: number | null;
  modelUsed?: string | null;
  routerReason?: string | null;
  ceoConfidence?: number | null;
};

// Persists a TurnSignal row. Idempotent via messageId @unique — a retried
// turn (rare) safely no-ops on the second call. Never throws — a failed
// telemetry write must NOT take down the merchant's chat stream, so we
// log and swallow.
export async function recordTurnSignal(
  input: RecordTurnSignalInput,
): Promise<void> {
  try {
    await prisma.turnSignal.upsert({
      where: { messageId: input.messageId },
      create: {
        storeId: input.storeId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        outcome: input.outcome,
        toolCalls: input.toolCalls,
        hadWriteTool: input.hadWriteTool,
        hadClarification: input.hadClarification,
        hadPlan: input.hadPlan ?? false,
        latencyMs: input.latencyMs ?? null,
        modelUsed: input.modelUsed ?? null,
        routerReason: input.routerReason ?? null,
        ceoConfidence: input.ceoConfidence ?? null,
      },
      update: {
        // Only the outcome can change post-creation (reclassifier promotes
        // informational → rephrased / abandoned). Everything else is
        // recorded once and never updated.
        outcome: input.outcome,
      },
    });
  } catch (err) {
    log.error("recordTurnSignal failed", { err, messageId: input.messageId });
  }
}

// V2.2 — called from api.tool-approve / api.tool-reject after writes
// resolve. Finds the most recent TurnSignal in this conversation that
// represents a write turn awaiting resolution (still labelled
// "informational" with `hadWriteTool: true`) and promotes its outcome
// to "approved" or "rejected".
//
// Why "informational" not a dedicated "pending" state? At SSE done time
// pending writes are still ambiguous — the merchant might walk away
// without clicking. Tagging them "informational" lets the abandoned
// sweep (which only looks at "informational") catch the walk-away case.
// The tradeoff: there's a small window where the admin view shows
// "informational" for a write turn until the merchant clicks. Acceptable.
//
// Idempotent: only flips rows still labelled "informational", so a
// retried approve/reject doesn't accidentally overwrite a more
// specific outcome.
export async function promoteWriteTurnSignal(opts: {
  storeId: string;
  conversationId: string;
  outcome: "approved" | "rejected";
}): Promise<void> {
  try {
    const latest = await prisma.turnSignal.findFirst({
      where: {
        storeId: opts.storeId,
        conversationId: opts.conversationId,
        hadWriteTool: true,
        outcome: "informational",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!latest) return;
    await prisma.turnSignal.updateMany({
      where: { id: latest.id, outcome: "informational" },
      data: { outcome: opts.outcome },
    });
  } catch (err) {
    log.error("promoteWriteTurnSignal failed", { err });
  }
}
