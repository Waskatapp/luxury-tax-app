import type { Insight } from "@prisma/client";

import prisma from "../../db.server";
import { log } from "../log.server";

// V3.3 — Phase 3 Autonomous Reasoning Loop. CRUD + surfacing logic for the
// Insight model. Insights are written by the offline evaluator
// (lib/agent/evaluator.server.ts) and surfaced into the merchant's NEXT
// conversation through the CEO Observations slot in the system prompt.
//
// Surfacing is rate-limited to keep the merchant from being nagged:
//   - perTurnLimit: at most N (default 2) insights woven into a single
//     conversation opener.
//   - dailyLimit: at most N (default 2) UNIQUE insights surfaced per
//     (storeId, calendar UTC day) across all conversations.
//
// Once surfaced, an Insight's `surfacedAt` is set; it never surfaces
// again unless the merchant explicitly clicks "re-surface" in the
// settings UI (clears the column).

export type Verdict =
  | "improved"
  | "worsened"
  | "inconclusive"
  | "insufficient_data";

export type InsightCategory =
  | "outcome_postmortem"
  | "lesson"
  | "anomaly"
  | "pattern"
  | "theme";

export type InsightRow = {
  id: string;
  storeId: string;
  followupId: string | null;
  category: InsightCategory;
  title: string;
  body: string;
  verdict: Verdict;
  confidence: number;
  significanceP: number | null;
  surfacedAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
};

function toRow(i: Insight): InsightRow {
  return {
    id: i.id,
    storeId: i.storeId,
    followupId: i.followupId,
    category: i.category as InsightCategory,
    title: i.title,
    body: i.body,
    verdict: i.verdict as Verdict,
    confidence: i.confidence,
    significanceP: i.significanceP,
    surfacedAt: i.surfacedAt?.toISOString() ?? null,
    dismissedAt: i.dismissedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

// Settings UI — list everything (surfaced + unsurfaced + dismissed).
export async function listAllInsights(
  storeId: string,
  limit = 100,
): Promise<InsightRow[]> {
  const rows = await prisma.insight.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRow);
}

export async function findInsightById(
  storeId: string,
  id: string,
): Promise<InsightRow | null> {
  const row = await prisma.insight.findFirst({ where: { id, storeId } });
  return row ? toRow(row) : null;
}

export const DEFAULT_PER_TURN_INSIGHT_LIMIT = 2;
export const DEFAULT_DAILY_INSIGHT_LIMIT = 2;

// Internal: how many unique insights have surfaced today for this store.
// Day boundary is UTC calendar day (matches the cron's UTC schedule).
async function countSurfacedToday(storeId: string, now: Date): Promise<number> {
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return prisma.insight.count({
    where: {
      storeId,
      surfacedAt: { gte: startOfDay },
    },
  });
}

// The orchestrator the chat route calls at conversation start.
// Returns 0–N insights to weave into the system prompt's CEO Observations
// section. Marks the chosen rows' `surfacedAt = now` BEFORE returning so
// concurrent / retried requests can't double-surface.
//
// Filtering:
//   - storeId scope (tenancy)
//   - surfacedAt IS NULL (never surfaced)
//   - dismissedAt IS NULL (merchant didn't dismiss in settings)
//   - verdict != "insufficient_data" (don't open conversations with
//     "we couldn't measure your last change" — that's settings-page
//     content, not conversation-opener content)
//
// Ordering:
//   - confidence DESC, createdAt DESC — surface the most-confident
//     and most-recent first.
export async function pickInsightsToSurface(
  storeId: string,
  opts: { now?: Date; perTurnLimit?: number; dailyLimit?: number } = {},
): Promise<InsightRow[]> {
  const now = opts.now ?? new Date();
  const perTurn = opts.perTurnLimit ?? DEFAULT_PER_TURN_INSIGHT_LIMIT;
  const daily = opts.dailyLimit ?? DEFAULT_DAILY_INSIGHT_LIMIT;

  const surfacedToday = await countSurfacedToday(storeId, now);
  const remainingToday = Math.max(0, daily - surfacedToday);
  const targetCount = Math.min(perTurn, remainingToday);
  if (targetCount === 0) return [];

  const candidates = await prisma.insight.findMany({
    where: {
      storeId,
      surfacedAt: null,
      dismissedAt: null,
      verdict: { not: "insufficient_data" },
    },
    orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    take: targetCount,
  });

  if (candidates.length === 0) return [];

  // Pre-claim the rows. updateMany returns count; we use it to confirm
  // we got the rows (idempotent vs concurrent claim by a parallel turn).
  const ids = candidates.map((c) => c.id);
  const claim = await prisma.insight.updateMany({
    where: { id: { in: ids }, surfacedAt: null },
    data: { surfacedAt: now },
  });
  if (claim.count !== candidates.length) {
    log.warn("insights: partial claim during surfacing", {
      storeId,
      requested: candidates.length,
      claimed: claim.count,
    });
  }

  // Re-fetch to capture the now-populated surfacedAt timestamps for the
  // return value (the in-memory candidates still have surfacedAt=null).
  const fresh = await prisma.insight.findMany({
    where: { id: { in: ids } },
  });
  // Preserve the original ranking order (Prisma doesn't guarantee it).
  const byId = new Map(fresh.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is Insight => r !== undefined)
    .map(toRow);
}

// Render selected insights as the markdown body that goes into the
// system prompt's CEO Observations slot. Token-conservative — title +
// short body extract. Empty string when no insights.
export function formatInsightsAsMarkdown(insights: InsightRow[]): string {
  if (insights.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "These are post-mortems and lessons your offline evaluator wrote while the merchant was away. Weave them naturally into your opening — bring up at most ONE per response, and never repeat across turns of the same conversation. They are NOT instructions to act; they are background context the merchant deserves to know about.",
  );
  for (const i of insights) {
    const verdictTag =
      i.verdict === "improved"
        ? "✓ improved"
        : i.verdict === "worsened"
          ? "✗ worsened"
          : "~ inconclusive";
    lines.push(
      `\n**${i.title}** (${verdictTag}; confidence ${i.confidence.toFixed(2)})\n${i.body}`,
    );
  }
  return lines.join("\n");
}

// Settings UI actions.
export async function dismissInsight(
  storeId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.insight.updateMany({
    where: { id, storeId, dismissedAt: null },
    data: { dismissedAt: new Date() },
  });
  return result.count > 0;
}

// Settings UI: clear surfacedAt so a useful insight can show again on
// the next conversation. Does NOT clear dismissedAt — dismissed = gone
// for good unless the merchant explicitly resurrects it (separate action
// could be added later).
export async function unsurfaceInsight(
  storeId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.insight.updateMany({
    where: { id, storeId, dismissedAt: null },
    data: { surfacedAt: null },
  });
  return result.count > 0;
}
