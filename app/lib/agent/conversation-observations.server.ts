// Phase Mn Round Mn-3 — in-conversation positive observation scratchpad.
//
// Counterpart to ConversationFailure (Wf-C). When the agent learns
// something non-obvious during a turn — a catalog category breakdown, a
// merchant preference, the shape of a returned list — it calls
// `note_observation` to save the learning. At the next turn-start, the
// observationAugmenter pulls the most-recent distinct-kind rows and
// surfaces them as an "Observations so far in this conversation" block
// so the agent doesn't re-read the same data 5 turns later.
//
// Best-effort throughout — recording errors are logged + swallowed so a
// hiccup here can never break the agent loop. The observation is purely
// additive context; the agent can always re-read if it needs fresh state.

import prisma from "../../db.server";
import { log } from "../log.server";

// Bounds. Documented as constants so tests + readers can see them.
export const RECENT_OBSERVATIONS_LIMIT = 5;
export const MAX_OBSERVATIONS_PER_CONVERSATION = 30;
export const OBSERVATION_DEDUPE_WINDOW_MS = 60_000;

// Hard caps on stored string size — defense against an agent that tries
// to dump 5000-char summaries into the table. Mirrors the 500-char cap
// from the Zod meta-tool schema in tools.ts.
export const MAX_OBSERVATION_SUMMARY_LEN = 500;
export const MAX_OBSERVATION_KIND_LEN = 40;

export type ConversationObservationRow = {
  id: string;
  storeId: string;
  conversationId: string;
  kind: string;
  summary: string;
  sourceToolName: string | null;
  createdAt: Date;
};

// Best-effort insert. Deduplicates within OBSERVATION_DEDUPE_WINDOW_MS on
// (kind + summary) — the agent calling note_observation twice with the
// same content (e.g., re-emitting on retry) writes only ONE row.
export async function recordObservation(opts: {
  storeId: string;
  conversationId: string;
  kind: string;
  summary: string;
  sourceToolName?: string | null;
}): Promise<void> {
  try {
    const kind = opts.kind.slice(0, MAX_OBSERVATION_KIND_LEN);
    const summary = opts.summary.slice(0, MAX_OBSERVATION_SUMMARY_LEN);
    const cutoff = new Date(Date.now() - OBSERVATION_DEDUPE_WINDOW_MS);
    const existing = await prisma.conversationObservation.findFirst({
      where: {
        conversationId: opts.conversationId,
        storeId: opts.storeId,
        kind,
        summary,
        createdAt: { gt: cutoff },
      },
      select: { id: true },
    });
    if (existing) return; // dedupe hit — no-op

    await prisma.conversationObservation.create({
      data: {
        storeId: opts.storeId,
        conversationId: opts.conversationId,
        kind,
        summary,
        sourceToolName: opts.sourceToolName ?? null,
      },
    });
  } catch (err) {
    log.error("conversation-observations: recordObservation failed", {
      storeId: opts.storeId,
      conversationId: opts.conversationId,
      kind: opts.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Pull the most-recent observations for a conversation, deduped by `kind`
// (most recent per distinct kind wins). Returns up to `limit` entries.
// Used by the observationAugmenter to format the block.
export async function recentObservations(
  storeId: string,
  conversationId: string,
  limit: number = RECENT_OBSERVATIONS_LIMIT,
): Promise<ConversationObservationRow[]> {
  try {
    const rows = await prisma.conversationObservation.findMany({
      where: { storeId, conversationId },
      orderBy: { createdAt: "desc" },
      take: limit * 4,
    });
    const seen = new Set<string>();
    const out: ConversationObservationRow[] = [];
    for (const r of rows) {
      if (seen.has(r.kind)) continue;
      seen.add(r.kind);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    log.error("conversation-observations: recentObservations failed", {
      storeId,
      conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// Bounded retention. Keeps the most recent `keepLast` rows; deletes older.
// Called opportunistically once per turn (after recordObservation) so the
// table stays small for active conversations.
export async function pruneOldObservations(
  conversationId: string,
  keepLast: number = MAX_OBSERVATIONS_PER_CONVERSATION,
): Promise<void> {
  try {
    const rows = await prisma.conversationObservation.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      skip: keepLast,
      select: { id: true },
    });
    if (rows.length === 0) return;
    await prisma.conversationObservation.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
  } catch (err) {
    log.error("conversation-observations: pruneOldObservations failed", {
      conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Format the observations-block body for injection into the system
// instruction. Returns null when there's nothing to inject so the
// augmenter pipeline can omit the heading entirely.
export function formatObservationsBlock(
  observations: ConversationObservationRow[],
): string | null {
  if (observations.length === 0) return null;
  const lines = observations.map((o) => {
    const src = o.sourceToolName ? ` (from \`${o.sourceToolName}\`)` : "";
    return `- **${o.kind}**${src}: ${o.summary}`;
  });
  return [
    "Things you've learned earlier in this conversation. Use these to avoid re-reading the same data. They may be stale if the merchant changed something outside the chat — re-fetch if a write depends on the exact current state.",
    ...lines,
  ].join("\n");
}
