// Phase Wf Round Wf-C — in-conversation failure scratchpad.
//
// When a tool fails with a structured error code (Phase Re-A), record one
// row here. At the next turn-start, the failureLessonsAugmenter pulls the
// most-recent distinct-code rows and surfaces them as a "Lessons from this
// conversation so far" block in the system instruction. Outcome: the agent
// stops re-attempting the same blocked path within a single conversation.
//
// Best-effort throughout — recording errors are logged + swallowed so a
// hiccup here can never break the agent loop. The tool failure itself is
// already surfaced via the tool_result block; the lessons block is purely
// additive context.

import prisma from "../../db.server";
import { log } from "../log.server";

// Bounds. Documented as constants so tests + readers can see them.
export const RECENT_FAILURES_LIMIT = 5;
export const MAX_FAILURES_PER_CONVERSATION = 20;
export const DEDUPE_WINDOW_MS = 60_000;

export type ConversationFailureRow = {
  id: string;
  storeId: string;
  conversationId: string;
  toolName: string;
  code: string;
  errorMessage: string;
  createdAt: Date;
};

// Best-effort insert. Deduplicates within DEDUPE_WINDOW_MS on
// (toolName + code + errorMessage) — runaway loops re-firing the same
// failure 100 times in a turn write only ONE row.
export async function recordFailure(opts: {
  storeId: string;
  conversationId: string;
  toolName: string;
  code: string;
  errorMessage: string;
}): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await prisma.conversationFailure.findFirst({
      where: {
        conversationId: opts.conversationId,
        storeId: opts.storeId,
        toolName: opts.toolName,
        code: opts.code,
        errorMessage: opts.errorMessage,
        createdAt: { gt: cutoff },
      },
      select: { id: true },
    });
    if (existing) return; // dedupe hit — no-op

    await prisma.conversationFailure.create({
      data: {
        storeId: opts.storeId,
        conversationId: opts.conversationId,
        toolName: opts.toolName,
        code: opts.code,
        errorMessage: opts.errorMessage.slice(0, 500), // bound row size
      },
    });
  } catch (err) {
    log.error("conversation-failures: recordFailure failed", {
      storeId: opts.storeId,
      conversationId: opts.conversationId,
      toolName: opts.toolName,
      code: opts.code,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Pull the most-recent failures for a conversation, deduped by `code`
// (most recent per distinct code wins). Returns up to `limit` entries.
// Used by the failureLessonsAugmenter to format the lessons block.
export async function recentFailures(
  storeId: string,
  conversationId: string,
  limit: number = RECENT_FAILURES_LIMIT,
): Promise<ConversationFailureRow[]> {
  try {
    // Pull a generous window then dedupe by code. Limit * 4 covers the
    // common case where a single failure repeats — we still want enough
    // history to find DISTINCT codes.
    const rows = await prisma.conversationFailure.findMany({
      where: { storeId, conversationId },
      orderBy: { createdAt: "desc" },
      take: limit * 4,
    });
    const seen = new Set<string>();
    const out: ConversationFailureRow[] = [];
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    log.error("conversation-failures: recentFailures failed", {
      storeId,
      conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// Bounded retention. Keeps the most recent `keepLast` rows; deletes older.
// Called opportunistically once per turn (after recordFailure) so the
// table stays small for active conversations.
export async function pruneOldFailures(
  conversationId: string,
  keepLast: number = MAX_FAILURES_PER_CONVERSATION,
): Promise<void> {
  try {
    const rows = await prisma.conversationFailure.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      skip: keepLast,
      select: { id: true },
    });
    if (rows.length === 0) return;
    await prisma.conversationFailure.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
  } catch (err) {
    log.error("conversation-failures: pruneOldFailures failed", {
      conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Format the lessons-block body for injection into the system instruction.
// Returns null when there's nothing to inject so the augmenter pipeline
// can omit the heading entirely.
export function formatLessonsBlock(
  failures: ConversationFailureRow[],
): string | null {
  if (failures.length === 0) return null;
  const lines = failures.map((f) => {
    // Compact format: tool returned CODE — error gist
    const errGist = f.errorMessage.length > 120
      ? f.errorMessage.slice(0, 117) + "…"
      : f.errorMessage;
    return `- \`${f.toolName}\` returned ${f.code} — ${errGist}`;
  });
  return [
    "Failures recorded in this conversation. Don't re-attempt the same path against the same input — these errors already happened. If the merchant explicitly asks to retry, acknowledge the prior failure first; this state may be stale if they fixed it manually.",
    ...lines,
  ].join("\n");
}
