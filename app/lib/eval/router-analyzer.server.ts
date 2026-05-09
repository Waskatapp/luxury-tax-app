// Phase 8 — routing analyzer. Reads the last N days of TurnSignal rows
// for a store and surfaces patterns that suggest the model router is
// over-modeling (Flash on trivial reads → wasted cost) or under-modeling
// (Flash-Lite on complex turns → abandonment).
//
// Operator-only — findings emit as RawFinding rows that the orchestrator
// files into SystemHealthFinding (operator-only by construction; never
// surfaced to merchant chat per CLAUDE.md rule 11).
//
// Constitutional posture:
//   1. Per-store iteration. The analyzer takes a storeId; the cron
//      walks prisma.store.findMany() and calls once per store.
//   2. Read-only on TurnSignal. NEVER writes back to TurnSignal,
//      NEVER mutates router config, NEVER injects into the CEO
//      prompt. Only emits RawFinding rows.
//   3. No LLM calls. Pure SQL aggregation + math. Deterministic.
//   4. Same-day dedupe via the orchestrator's spam guard
//      (7-day per (storeId, component) window). Each detector uses
//      a unique component name so they don't squash each other.

import prisma from "../../db.server";

import type { RawFinding } from "../agent/system-health.server";

// How many days of TurnSignal to scan. 7 gives enough sample size
// (typically 50-200 turns at the scale of v1 merchants) without
// pulling stale signals from before recent prompt changes.
const DEFAULT_LOOKBACK_DAYS = 7;

// Minimum sample sizes per detector before we'll emit a finding —
// prevents noise-driven findings on stores with sparse traffic.
const MIN_TURNS_FOR_OVER_MODELED = 20;
const MIN_TURNS_FOR_UNDER_MODELED = 10;
const MIN_TURNS_FOR_FIRST_WORD = 5;
const MIN_TURNS_FOR_ROUTER_REASON = 5;

// "Fast path" threshold for the over-modeled detector. A turn with no
// tools and < 2s latency is by definition not exercising Flash's
// reasoning advantage; if we see a critical mass of these on Flash,
// the router could safely route them to Flash-Lite.
const FAST_PATH_LATENCY_MS = 2000;

// Abandonment-rate threshold for the first-word and router-reason
// detectors. > 50% means the majority of these turns ended without
// the merchant engaging. That's a stronger signal than a single
// abandoned turn.
const ABANDONMENT_RATE_THRESHOLD = 0.5;

export type RouterAnalyzerInput = {
  storeId: string;
  now: Date;
  lookbackDays?: number;
};

// Slim shape we read from TurnSignal — keeps the query cheap and
// the type-checker honest. Fields hydrated lazily (only the columns
// each detector needs).
type TurnSignalRow = {
  outcome: string;
  toolCalls: number;
  hadWriteTool: boolean;
  latencyMs: number | null;
  modelUsed: string | null;
  routerReason: string | null;
};

export async function analyzeRoutingForStore(
  input: RouterAnalyzerInput,
): Promise<RawFinding[]> {
  const lookback = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const cutoff = new Date(
    input.now.getTime() - lookback * 24 * 60 * 60 * 1000,
  );

  const rows: TurnSignalRow[] = await prisma.turnSignal.findMany({
    where: {
      storeId: input.storeId,
      createdAt: { gte: cutoff },
    },
    select: {
      outcome: true,
      toolCalls: true,
      hadWriteTool: true,
      latencyMs: true,
      modelUsed: true,
      routerReason: true,
    },
    take: 5000,
  });

  if (rows.length === 0) return [];

  const findings: RawFinding[] = [];

  const overModeled = detectOverModeledFastPaths(rows, lookback);
  if (overModeled !== null) findings.push(overModeled);

  const underModeled = detectUnderModeledSlowPaths(rows, lookback);
  if (underModeled !== null) findings.push(underModeled);

  // First-word and router-reason detectors also surface user-message
  // patterns; user message text isn't on TurnSignal, but routerReason
  // captures WHY the router picked the tier (which encodes the
  // first-word match), so we can group on that.
  const byRouterReason = detectAbandonmentByRouterReason(rows, lookback);
  if (byRouterReason !== null) findings.push(byRouterReason);

  const latencyOutliers = detectLatencyOutliers(rows, lookback);
  if (latencyOutliers !== null) findings.push(latencyOutliers);

  return findings;
}

// Detector 1 — turns on Flash with < 2s latency AND zero tool calls.
// These are turns Flash-Lite would have handled at the same quality
// for ~3-4× less cost.
export function detectOverModeledFastPaths(
  rows: TurnSignalRow[],
  lookbackDays: number,
): RawFinding | null {
  const flashRows = rows.filter((r) => r.modelUsed === "gemini-2.5-flash");
  if (flashRows.length < MIN_TURNS_FOR_OVER_MODELED) return null;

  const fastZeroTool = flashRows.filter(
    (r) =>
      r.toolCalls === 0 &&
      r.latencyMs !== null &&
      r.latencyMs < FAST_PATH_LATENCY_MS &&
      !r.hadWriteTool &&
      r.outcome === "informational",
  );
  if (fastZeroTool.length === 0) return null;

  const ratio = fastZeroTool.length / flashRows.length;
  // Require at least 25% of Flash turns to be over-modeled before
  // flagging. Below that threshold the cost-saving opportunity is too
  // small to justify a router heuristic change.
  if (ratio < 0.25) return null;

  return {
    component: "router-over-modeled",
    scanName: "routerAnalysis",
    severity: "info",
    message: `${fastZeroTool.length} of ${flashRows.length} Flash turns in the last ${lookbackDays}d looked like fast-path read-only summaries (no tool, <${FAST_PATH_LATENCY_MS}ms, informational outcome). They could likely run on Flash-Lite at ~3-4× lower cost.`,
    recommendation:
      "Inspect a sample of these turns in /app/settings/turn-signals. If the user messages share a phrasing pattern not yet covered by SIMPLE_QUESTION_LEADS or SIMPLE_QUESTION_PREFIXES in app/lib/agent/model-router.ts, propose adding it. NEVER auto-tune; humans approve via PR.",
    evidence: {
      lookbackDays,
      flashTurns: flashRows.length,
      fastPathFlashTurns: fastZeroTool.length,
      ratio: Math.round(ratio * 100) / 100,
      latencyThresholdMs: FAST_PATH_LATENCY_MS,
    },
  };
}

// Detector 2 — turns on Flash-Lite that ended in clarified or
// abandoned. Suggests Flash-Lite couldn't carry the load and the
// merchant gave up or had to rephrase.
export function detectUnderModeledSlowPaths(
  rows: TurnSignalRow[],
  lookbackDays: number,
): RawFinding | null {
  const liteRows = rows.filter(
    (r) => r.modelUsed === "gemini-2.5-flash-lite",
  );
  if (liteRows.length < MIN_TURNS_FOR_UNDER_MODELED) return null;

  const struggled = liteRows.filter(
    (r) => r.outcome === "clarified" || r.outcome === "abandoned",
  );
  if (struggled.length === 0) return null;

  const ratio = struggled.length / liteRows.length;
  // Require at least 30% of Flash-Lite turns to have struggled —
  // below that, occasional clarifications are normal noise.
  if (ratio < 0.3) return null;

  return {
    component: "router-under-modeled",
    scanName: "routerAnalysis",
    severity: "warn",
    message: `${struggled.length} of ${liteRows.length} Flash-Lite turns in the last ${lookbackDays}d ended in clarified or abandoned. Flash-Lite may be under-serving these intents.`,
    recommendation:
      "Inspect the user messages of these turns. If they share a pattern that the router currently sends to Flash-Lite (slash command tier hint, simple-question first-word match), consider tightening the heuristic so Flash carries them. The eval harness's curated scenarios are the regression bar before changing model-router.ts.",
    evidence: {
      lookbackDays,
      liteTurns: liteRows.length,
      struggledTurns: struggled.length,
      ratio: Math.round(ratio * 100) / 100,
    },
  };
}

// Detector 3 — abandonment grouped by router reason. Surfaces WHICH
// heuristic is correlating with abandonment so the operator knows
// which routing rule to scrutinize.
export function detectAbandonmentByRouterReason(
  rows: TurnSignalRow[],
  lookbackDays: number,
): RawFinding | null {
  const byReason = new Map<string, { total: number; abandoned: number }>();
  for (const r of rows) {
    if (r.routerReason === null) continue;
    const bucket = byReason.get(r.routerReason) ?? { total: 0, abandoned: 0 };
    bucket.total += 1;
    if (r.outcome === "abandoned") bucket.abandoned += 1;
    byReason.set(r.routerReason, bucket);
  }

  let worst: { reason: string; total: number; abandoned: number; rate: number } | null = null;
  for (const [reason, bucket] of byReason.entries()) {
    if (bucket.total < MIN_TURNS_FOR_ROUTER_REASON) continue;
    const rate = bucket.abandoned / bucket.total;
    if (rate < ABANDONMENT_RATE_THRESHOLD) continue;
    if (worst === null || rate > worst.rate) {
      worst = { reason, total: bucket.total, abandoned: bucket.abandoned, rate };
    }
  }

  if (worst === null) return null;

  return {
    component: "router-abandonment-by-reason",
    scanName: "routerAnalysis",
    severity: "warn",
    message: `${Math.round(worst.rate * 100)}% abandonment on turns where router reason was "${worst.reason}" (${worst.abandoned} of ${worst.total} turns over ${lookbackDays}d).`,
    recommendation:
      "This routing reason is correlated with merchant disengagement. Inspect a sample of these turns to see whether the agent's response was wrong, slow, or off-topic. If the router heuristic is firing on the wrong signal, propose a model-router.ts edit and add a regression scenario before merging.",
    evidence: {
      lookbackDays,
      routerReason: worst.reason,
      total: worst.total,
      abandoned: worst.abandoned,
      rate: Math.round(worst.rate * 100) / 100,
      threshold: ABANDONMENT_RATE_THRESHOLD,
    },
  };
}

// Detector 4 — latency outliers. The slowest 5% of turns; if they
// cluster on one model or router reason, the operator should look.
export function detectLatencyOutliers(
  rows: TurnSignalRow[],
  lookbackDays: number,
): RawFinding | null {
  const withLatency = rows.filter(
    (r): r is TurnSignalRow & { latencyMs: number } => r.latencyMs !== null,
  );
  if (withLatency.length < MIN_TURNS_FOR_OVER_MODELED) return null;

  const sorted = [...withLatency].sort((a, b) => a.latencyMs - b.latencyMs);
  const p95Index = Math.floor(sorted.length * 0.95);
  const p95 = sorted[p95Index]?.latencyMs ?? 0;
  const outliers = withLatency.filter((r) => r.latencyMs >= p95);
  if (outliers.length === 0) return null;

  // Cluster outliers by router reason. If > 60% share a reason, surface it.
  const byReason = new Map<string, number>();
  for (const r of outliers) {
    const key = r.routerReason ?? "(no reason)";
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  let dominantReason: string | null = null;
  let dominantCount = 0;
  for (const [reason, count] of byReason.entries()) {
    if (count > dominantCount) {
      dominantReason = reason;
      dominantCount = count;
    }
  }
  if (dominantReason === null) return null;

  const dominantShare = dominantCount / outliers.length;
  if (dominantShare < 0.6) return null;

  return {
    component: "router-latency-outliers",
    scanName: "routerAnalysis",
    severity: "info",
    message: `${Math.round(dominantShare * 100)}% of p95+ slow turns over ${lookbackDays}d share router reason "${dominantReason}" (${dominantCount} of ${outliers.length} outliers, p95 = ${p95}ms).`,
    recommendation:
      "Latency outliers clustering on one routing decision suggest either a slow tool call common to that path, or the wrong model tier handling a workload too heavy for it. Inspect the conversations behind these turns to determine which.",
    evidence: {
      lookbackDays,
      p95Ms: p95,
      outlierCount: outliers.length,
      dominantReason,
      dominantCount,
      dominantShare: Math.round(dominantShare * 100) / 100,
    },
  };
}

// Re-exported for tests; orchestrator uses MIN_TURNS_FOR_FIRST_WORD
// constant via the detector internals.
export const ROUTER_ANALYZER_THRESHOLDS = {
  fastPathLatencyMs: FAST_PATH_LATENCY_MS,
  abandonmentRateThreshold: ABANDONMENT_RATE_THRESHOLD,
  minTurnsForOverModeled: MIN_TURNS_FOR_OVER_MODELED,
  minTurnsForUnderModeled: MIN_TURNS_FOR_UNDER_MODELED,
  minTurnsForFirstWord: MIN_TURNS_FOR_FIRST_WORD,
  minTurnsForRouterReason: MIN_TURNS_FOR_ROUTER_REASON,
};
