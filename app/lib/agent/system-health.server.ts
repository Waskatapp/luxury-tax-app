import type { SystemHealthFinding } from "@prisma/client";
import { z } from "zod";

import prisma from "../../db.server";
import { GEMINI_MEMORY_MODEL, getGeminiClient } from "./gemini.server";
import { log } from "../log.server";

// V6.6 — Phase 6.6 IT Diagnostic (simple version). Operator-only system-
// health findings written by the daily cron's diagnostic pass
// (scripts/run-evaluator.ts). NEVER surfaced to the merchant. NEVER
// injected into the CEO prompt. Visible only at /app/settings/system-health.
//
// This is the diagnostic / observability arm of the deferred IT
// department. The full code-writing arm (Anthropic Claude opening PRs
// against the codebase) is a later phase that will read THIS table as
// input. By the time we wire up the code-writer, this table tells us
// *what kinds of bugs we make*, which makes the IT agent's prompt
// tractable.
//
// Architecture posture (the constitution for this module):
//   1. Operator-only. Findings never reach merchant chat.
//   2. Read-only on operational tables (Decision, AuditLog, TurnSignal,
//      Conversation, Insight, PendingAction). Only SystemHealthFinding
//      is written by this pass.
//   3. Tenant-scoped. Every query has where: { storeId }.
//   4. Per-store iteration via runSystemHealthScansForStore. No cross-
//      store aggregation in v1.
//   5. 7-day spam guard per (storeId, component). Snooze-expiry counts
//      as "no recent finding" so a snoozed-then-expired component can
//      re-fire.

export type Severity = "info" | "warn" | "critical";

// What a scan returns. The orchestrator decides whether to file based on
// the spam guard. Never thrown — scans return null on no-finding and
// catch their own errors so a bad scan doesn't poison the pass.
export type RawFinding = {
  component: string;
  scanName: string;
  severity: Severity;
  message: string;
  recommendation: string;
  evidence: Record<string, unknown>;
};

// Settings-page row shape (Date → ISO string for serialization across
// the Remix loader boundary). Mirrors insights.server.ts InsightRow.
export type FindingRow = {
  id: string;
  storeId: string;
  component: string;
  severity: Severity;
  scanName: string;
  message: string;
  recommendation: string;
  evidence: Record<string, unknown>;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  snoozedUntil: string | null;
  createdAt: string;
};

export type ScanResult = {
  scansRun: number;
  findingsFiled: number;
  skippedSpamGuard: number;
  errors: number;
};

export type ScanFn = (opts: {
  storeId: string;
  now: Date;
}) => Promise<RawFinding | null>;

const SPAM_GUARD_DAYS = 7;

// Pure converter for the loader boundary.
function toRow(f: SystemHealthFinding): FindingRow {
  return {
    id: f.id,
    storeId: f.storeId,
    component: f.component,
    severity: f.severity as Severity,
    scanName: f.scanName,
    message: f.message,
    recommendation: f.recommendation,
    evidence:
      typeof f.evidence === "object" && f.evidence !== null
        ? (f.evidence as Record<string, unknown>)
        : {},
    acknowledgedAt: f.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: f.acknowledgedBy,
    snoozedUntil: f.snoozedUntil?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
  };
}

// Spam guard: returns true if a NEW finding for (storeId, component)
// can be filed right now. Returns false if a recent finding already
// exists in the 7-day window AND that finding is not snooze-expired.
//
// "Snoozed-expired" treatment: if the operator snoozed a finding for N
// days and that snooze has passed, re-firing is allowed even within the
// createdAt window. This lets the operator say "remind me later" without
// permanently muting the component.
//
// Bounded by the (storeId, component, createdAt) index — fast even at
// scale.
export async function shouldFileSystemHealthFinding(
  storeId: string,
  component: string,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(
    now.getTime() - SPAM_GUARD_DAYS * 24 * 60 * 60 * 1000,
  );
  const blocking = await prisma.systemHealthFinding.findFirst({
    where: {
      storeId,
      component,
      createdAt: { gte: cutoff },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { gt: now } }],
    },
    select: { id: true },
  });
  return blocking === null;
}

// Internal: write one finding to the DB. Pure side-effect; orchestrator
// has already gated on spam guard.
async function fileFinding(
  storeId: string,
  raw: RawFinding,
): Promise<SystemHealthFinding> {
  return prisma.systemHealthFinding.create({
    data: {
      storeId,
      component: raw.component,
      severity: raw.severity,
      scanName: raw.scanName,
      message: raw.message,
      recommendation: raw.recommendation,
      evidence: raw.evidence as unknown as object,
    },
  });
}

// ----- Scans -----
//
// Each scan is async (storeId, now) → RawFinding | null. Threshold logic
// is factored into pure helpers above the scan body so unit tests can
// exercise the math without mocking Prisma. Threshold rationale lives
// in code as comments so the next operator (or you in 6 weeks) knows
// why this number.

// 6.1 — embeddingStuckScan. Detects Decisions with embeddingPending=true
// for >24h. Would have caught the text-embedding-004 deprecation in 24h
// instead of 100+ chat turns.
//
// Threshold: count >= 5. 1-4 is normal lazy-tick lag (api.chat.tsx
// processes 1-2 per request); 5+ over 24h means the tick failed for
// that store.
export const EMBEDDING_STUCK_HOURS = 24;
export const EMBEDDING_STUCK_MIN_COUNT = 5;

export function buildEmbeddingStuckFinding(opts: {
  stuckCount: number;
  oldestId: string;
  oldestCreatedAt: Date;
}): RawFinding | null {
  if (opts.stuckCount < EMBEDDING_STUCK_MIN_COUNT) return null;
  return {
    component: "embedding_pipeline",
    scanName: "embeddingStuckScan",
    severity: "warn",
    message: `${opts.stuckCount} Decision rows have been waiting for embeddings for over ${EMBEDDING_STUCK_HOURS}h. Decision retrieval is degraded — past-decision context isn't reaching new conversations.`,
    recommendation: `Check the Gemini embeddings API health and the post-stream embedding tick in app/routes/api.chat.tsx. The most common cause is a deprecated embedding model returning silent failures (precedent: text-embedding-004 → gemini-embedding-001 switch on 2026-04-30). Inspect server logs for "embedText failed" warnings.`,
    evidence: {
      stuckCount: opts.stuckCount,
      oldestId: opts.oldestId,
      oldestCreatedAt: opts.oldestCreatedAt.toISOString(),
      thresholdHours: EMBEDDING_STUCK_HOURS,
      thresholdMinCount: EMBEDDING_STUCK_MIN_COUNT,
    },
  };
}

async function embeddingStuckScan(opts: {
  storeId: string;
  now: Date;
}): Promise<RawFinding | null> {
  const cutoff = new Date(
    opts.now.getTime() - EMBEDDING_STUCK_HOURS * 60 * 60 * 1000,
  );
  const stuckCount = await prisma.decision.count({
    where: {
      storeId: opts.storeId,
      embeddingPending: true,
      createdAt: { lt: cutoff },
    },
  });
  if (stuckCount < EMBEDDING_STUCK_MIN_COUNT) return null;

  const oldest = await prisma.decision.findFirst({
    where: {
      storeId: opts.storeId,
      embeddingPending: true,
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  if (!oldest) return null; // race: cleared between count and findFirst

  return buildEmbeddingStuckFinding({
    stuckCount,
    oldestId: oldest.id,
    oldestCreatedAt: oldest.createdAt,
  });
}

// 6.6 — missingConversationTitleScan. Detects Conversations >24h old
// with title=null AND >=4 messages. Catches the title-generator
// (lib/agent/title-generator.server.ts) silently failing — happened
// before when post-stream title generation was gated on text > 0,
// causing tool-only turns to leave conversations untitled.
//
// Threshold: >=3 such conversations. 1-2 may be in flight (extremely
// short conversations that ended before the generator ran). 3+ over
// 24h with substantive content (4+ messages) is a pattern, not noise.
export const MISSING_TITLE_HOURS = 24;
export const MISSING_TITLE_MIN_MESSAGES = 4;
export const MISSING_TITLE_MIN_COUNT = 3;

export function buildMissingTitleFinding(opts: {
  count: number;
  sampleConversationIds: string[];
}): RawFinding | null {
  if (opts.count < MISSING_TITLE_MIN_COUNT) return null;
  return {
    component: "title_generator",
    scanName: "missingConversationTitleScan",
    severity: "warn",
    message: `${opts.count} conversation(s) older than ${MISSING_TITLE_HOURS}h with ${MISSING_TITLE_MIN_MESSAGES}+ messages have no title. The title generator is silently failing.`,
    recommendation: `Check app/lib/agent/title-generator.server.ts and the post-stream call site in app/routes/api.chat.tsx. Common cause: gating the title-gen call behind a buffer-length condition that excludes tool-only turns. Title-gen should fire whenever the conversation accumulates substantive content, regardless of whether THIS turn produced text.`,
    evidence: {
      count: opts.count,
      sampleConversationIds: opts.sampleConversationIds,
      thresholdHours: MISSING_TITLE_HOURS,
      thresholdMinMessages: MISSING_TITLE_MIN_MESSAGES,
      thresholdMinCount: MISSING_TITLE_MIN_COUNT,
    },
  };
}

async function missingConversationTitleScan(opts: {
  storeId: string;
  now: Date;
}): Promise<RawFinding | null> {
  const cutoff = new Date(
    opts.now.getTime() - MISSING_TITLE_HOURS * 60 * 60 * 1000,
  );
  // Pull candidates with their message counts in one query. Cap at 50
  // — we only need to know "are there >=3 substantive conversations"
  // and which 5 to sample for evidence; we don't need exhaustive count.
  const candidates = await prisma.conversation.findMany({
    where: {
      storeId: opts.storeId,
      title: null,
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const substantive = candidates.filter(
    (c) => c._count.messages >= MISSING_TITLE_MIN_MESSAGES,
  );
  if (substantive.length < MISSING_TITLE_MIN_COUNT) return null;

  return buildMissingTitleFinding({
    count: substantive.length,
    sampleConversationIds: substantive.slice(0, 5).map((c) => c.id),
  });
}

// 6.2 — toolFailureSpikeScan. Detects AuditLog rows with
// action="tool_failed" exceeding baseline. Catches Shopify schema
// changes, rate-limit regressions, or executor bugs that turn a healthy
// tool into a failing one.
//
// Threshold: any tool with last-24h failures >= max(3, 3× 7-day-baseline
// per-24h). 3 is the floor — single failures are noise. 3× baseline
// catches regressions on tools that legitimately fail occasionally
// (rate-limited APIs).
//
// Severity: critical if any tool has >=10 failures in 24h, else warn.
// Picks the WORST tool (highest absolute failures) per scan run, since
// the spam guard keys on component and we file at most one finding per
// scan invocation.
export const TOOL_FAILURE_FLOOR = 3;
export const TOOL_FAILURE_BASELINE_MULT = 3;
export const TOOL_FAILURE_CRITICAL_AT = 10;

export type ToolFailureCandidate = {
  toolName: string;
  failures24h: number;
  baselinePer24h: number;
  sampleAuditLogIds: string[];
};

// Pure: pick the worst-violating tool from candidates, or null if none
// cross the threshold.
export function pickWorstToolFailure(
  candidates: ToolFailureCandidate[],
): ToolFailureCandidate | null {
  let worst: ToolFailureCandidate | null = null;
  for (const c of candidates) {
    const dynamicThreshold = Math.max(
      TOOL_FAILURE_FLOOR,
      TOOL_FAILURE_BASELINE_MULT * c.baselinePer24h,
    );
    if (c.failures24h < dynamicThreshold) continue;
    if (worst === null || c.failures24h > worst.failures24h) {
      worst = c;
    }
  }
  return worst;
}

export function buildToolFailureFinding(
  c: ToolFailureCandidate,
): RawFinding {
  const severity: Severity =
    c.failures24h >= TOOL_FAILURE_CRITICAL_AT ? "critical" : "warn";
  return {
    component: "tool_failure_rate",
    scanName: "toolFailureSpikeScan",
    severity,
    message: `Tool '${c.toolName}' failed ${c.failures24h} time(s) in the last 24h (baseline ~${c.baselinePer24h.toFixed(1)}/24h). The CEO is calling it but Shopify or the executor is rejecting it.`,
    recommendation: `Inspect the AuditLog rows for '${c.toolName}' (action='tool_failed') to see the error payload. Common causes: Shopify GraphQL schema change, rate-limit regression, missing scope, malformed input from the CEO. Check app/lib/shopify/ for the tool implementation and app/lib/agent/executor.server.ts for the dispatch.`,
    evidence: {
      toolName: c.toolName,
      failures24h: c.failures24h,
      baselinePer24h: c.baselinePer24h,
      sampleAuditLogIds: c.sampleAuditLogIds,
      thresholdFloor: TOOL_FAILURE_FLOOR,
      thresholdBaselineMult: TOOL_FAILURE_BASELINE_MULT,
    },
  };
}

async function toolFailureSpikeScan(opts: {
  storeId: string;
  now: Date;
}): Promise<RawFinding | null> {
  const last24Cutoff = new Date(opts.now.getTime() - 24 * 60 * 60 * 1000);
  const baselineStart = new Date(opts.now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const baselineEnd = last24Cutoff;

  // Group failures per toolName for the last 24h.
  const last24 = await prisma.auditLog.groupBy({
    by: ["toolName"],
    where: {
      storeId: opts.storeId,
      action: "tool_failed",
      toolName: { not: null },
      createdAt: { gte: last24Cutoff },
    },
    _count: { _all: true },
  });
  if (last24.length === 0) return null;

  // Group failures per toolName for the prior 7-day baseline window.
  const baseline = await prisma.auditLog.groupBy({
    by: ["toolName"],
    where: {
      storeId: opts.storeId,
      action: "tool_failed",
      toolName: { not: null },
      createdAt: { gte: baselineStart, lt: baselineEnd },
    },
    _count: { _all: true },
  });
  const baselineByTool = new Map<string, number>();
  for (const r of baseline) {
    if (r.toolName) baselineByTool.set(r.toolName, r._count._all / 7);
  }

  // Build candidates and gather sample audit-log IDs for the worst.
  const candidates: ToolFailureCandidate[] = last24
    .filter((r) => r.toolName !== null)
    .map((r) => ({
      toolName: r.toolName as string,
      failures24h: r._count._all,
      baselinePer24h: baselineByTool.get(r.toolName as string) ?? 0,
      sampleAuditLogIds: [],
    }));

  const worst = pickWorstToolFailure(candidates);
  if (!worst) return null;

  // Pull sample audit-log IDs for the worst tool only — bounded query.
  const samples = await prisma.auditLog.findMany({
    where: {
      storeId: opts.storeId,
      action: "tool_failed",
      toolName: worst.toolName,
      createdAt: { gte: last24Cutoff },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true },
  });
  worst.sampleAuditLogIds = samples.map((s) => s.id);

  return buildToolFailureFinding(worst);
}

// 6.4 — latencyP95Scan. Detects TurnSignal.latencyMs p95 over the last
// 24h exceeding model-specific thresholds. Catches general slowness
// regressions (Gemini API degradation, runtime cold-start spikes,
// Shopify GraphQL slow responses cascading into long turn latencies).
//
// Thresholds chosen from observed production p95 + ~50% headroom:
//   gemini-2.5-flash:      p95 > 12000ms = warn, > 24000ms = critical
//   gemini-2.5-flash-lite: p95 > 6000ms  = warn, > 12000ms = critical
// Per-model thresholds because lite has roughly half the budget of flash.
//
// Min sample size: 20 turns. Below that, the percentile is too noisy.
export const LATENCY_MIN_SAMPLE = 20;
export const LATENCY_THRESHOLDS_MS: Record<
  string,
  { warn: number; critical: number }
> = {
  "gemini-2.5-flash": { warn: 12000, critical: 24000 },
  "gemini-2.5-flash-lite": { warn: 6000, critical: 12000 },
};

export type LatencyCandidate = {
  modelUsed: string;
  p50: number;
  p95: number;
  p99: number;
  sampleSize: number;
};

// Pure: classify a candidate's severity given the configured thresholds,
// or null if it doesn't violate.
export function classifyLatency(
  c: LatencyCandidate,
): { severity: Severity; warnAt: number; criticalAt: number } | null {
  const t = LATENCY_THRESHOLDS_MS[c.modelUsed];
  if (!t) return null; // unknown model — don't false-positive
  if (c.sampleSize < LATENCY_MIN_SAMPLE) return null;
  if (c.p95 >= t.critical) {
    return { severity: "critical", warnAt: t.warn, criticalAt: t.critical };
  }
  if (c.p95 >= t.warn) {
    return { severity: "warn", warnAt: t.warn, criticalAt: t.critical };
  }
  return null;
}

export function buildLatencyFinding(
  c: LatencyCandidate,
  classification: { severity: Severity; warnAt: number; criticalAt: number },
): RawFinding {
  return {
    component: "latency",
    scanName: "latencyP95Scan",
    severity: classification.severity,
    message: `Latency p95 for '${c.modelUsed}' is ${(c.p95 / 1000).toFixed(1)}s over the last 24h (warn at ${(classification.warnAt / 1000).toFixed(0)}s, critical at ${(classification.criticalAt / 1000).toFixed(0)}s; sample ${c.sampleSize} turns).`,
    recommendation: `Latency regressions usually trace to one of: (1) Gemini API itself (check status.cloud.google.com), (2) Shopify GraphQL slow responses inside read tools, (3) cold-start overhead on Railway after scale-down. Inspect TurnSignal rows with the highest latencyMs to see which tool calls are dominating the turn time.`,
    evidence: {
      modelUsed: c.modelUsed,
      p50Ms: Math.round(c.p50),
      p95Ms: Math.round(c.p95),
      p99Ms: Math.round(c.p99),
      sampleSize: c.sampleSize,
      warnThresholdMs: classification.warnAt,
      criticalThresholdMs: classification.criticalAt,
    },
  };
}

async function latencyP95Scan(opts: {
  storeId: string;
  now: Date;
}): Promise<RawFinding | null> {
  const cutoff = new Date(opts.now.getTime() - 24 * 60 * 60 * 1000);
  // Postgres percentile_cont via $queryRaw — Prisma doesn't expose it.
  // Returns one row per modelUsed. Ignore rows where modelUsed IS NULL.
  const rows = await prisma.$queryRaw<
    Array<{
      model_used: string;
      p50: number;
      p95: number;
      p99: number;
      sample_size: bigint;
    }>
  >`
    SELECT
      "modelUsed" AS model_used,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY "latencyMs") AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY "latencyMs") AS p99,
      COUNT(*) AS sample_size
    FROM "TurnSignal"
    WHERE "storeId" = ${opts.storeId}
      AND "createdAt" >= ${cutoff}
      AND "latencyMs" IS NOT NULL
      AND "modelUsed" IS NOT NULL
    GROUP BY "modelUsed"
  `;
  if (rows.length === 0) return null;

  // Pick the worst-violating model. classifyLatency returns null for
  // non-violators and unknown models.
  let worst: { c: LatencyCandidate; cls: ReturnType<typeof classifyLatency> } | null =
    null;
  for (const r of rows) {
    const c: LatencyCandidate = {
      modelUsed: r.model_used,
      p50: Number(r.p50),
      p95: Number(r.p95),
      p99: Number(r.p99),
      sampleSize: Number(r.sample_size),
    };
    const cls = classifyLatency(c);
    if (!cls) continue;
    if (worst === null || c.p95 > worst.c.p95) {
      worst = { c, cls };
    }
  }
  if (!worst || !worst.cls) return null;

  return buildLatencyFinding(worst.c, worst.cls);
}

// 6.5 — staleAnomalyInsightScan. Detects Insight rows with
// category='anomaly' (filed by memory-hygiene per Phase 6.4) that are
// older than 14 days and never dismissed. Either the conflicts are
// wrong (false-positive feedback signal — adjust the hygiene prompt) or
// the operator doesn't know they exist (UX bug — surfacing path is
// failing).
//
// Threshold: count >= 3. 1-2 may be in flight (operator hasn't checked
// the settings page recently). 3+ over two weeks is a pattern.
// Severity: info — operator-facing meta-signal, not a breakage.
export const STALE_ANOMALY_DAYS = 14;
export const STALE_ANOMALY_MIN_COUNT = 3;

export function buildStaleAnomalyFinding(opts: {
  staleCount: number;
  oldestId: string;
  oldestCreatedAt: Date;
}): RawFinding | null {
  if (opts.staleCount < STALE_ANOMALY_MIN_COUNT) return null;
  return {
    component: "stale_anomaly_insights",
    scanName: "staleAnomalyInsightScan",
    severity: "info",
    message: `${opts.staleCount} memory-hygiene anomaly Insight(s) older than ${STALE_ANOMALY_DAYS} days have not been dismissed. Either the conflicts are wrong, or the operator hasn't seen them.`,
    recommendation: `Visit /app/settings/insights and filter by 'anomaly' category. If the conflicts are real, dismiss or fix the underlying memory entries at /app/settings/memory. If they are false-positives, tune the hygiene prompt in app/lib/agent/memory-hygiene.server.ts (be more conservative — fewer flags is better than noisy ones).`,
    evidence: {
      staleCount: opts.staleCount,
      oldestId: opts.oldestId,
      oldestCreatedAt: opts.oldestCreatedAt.toISOString(),
      thresholdDays: STALE_ANOMALY_DAYS,
      thresholdMinCount: STALE_ANOMALY_MIN_COUNT,
    },
  };
}

async function staleAnomalyInsightScan(opts: {
  storeId: string;
  now: Date;
}): Promise<RawFinding | null> {
  const cutoff = new Date(
    opts.now.getTime() - STALE_ANOMALY_DAYS * 24 * 60 * 60 * 1000,
  );
  const staleCount = await prisma.insight.count({
    where: {
      storeId: opts.storeId,
      category: "anomaly",
      dismissedAt: null,
      createdAt: { lt: cutoff },
    },
  });
  if (staleCount < STALE_ANOMALY_MIN_COUNT) return null;

  const oldest = await prisma.insight.findFirst({
    where: {
      storeId: opts.storeId,
      category: "anomaly",
      dismissedAt: null,
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  if (!oldest) return null;

  return buildStaleAnomalyFinding({
    staleCount,
    oldestId: oldest.id,
    oldestCreatedAt: oldest.createdAt,
  });
}

// 6.3 — toolRejectionPatternScan. Detects a tool being rejected at
// >=50% rate over the last 7 days with >=10 absolute rejections. Catches
// the "yellow banner on first message" case — the CEO is firing a tool
// in contexts where the merchant always says no, indicating the CEO is
// misreading intent or jumping to writes too eagerly.
//
// Threshold: rejectionRate >= 0.5 AND totalRejected >= 10.
//   - 0.5 says the CEO is firing the tool wrong half the time.
//   - 10 absolute rules out small-N noise (a tool used twice and
//     rejected once is 50% but means nothing).
// Severity: warn — behavioral, not breakage.
//
// This is the only v1 scan that calls Flash-Lite for synthesis. The LLM
// pulls the last 5 rejected toolInput rows and produces a one-sentence
// hypothesis ("rejected when discount > 30%", "rejected when applied to
// a draft product", etc.). Fails soft: if the LLM call fails, the
// finding still files with llmHypothesis: null. The pattern is more
// useful WITH the hypothesis but the threshold-cross is still
// actionable without it.
export const REJECTION_RATE_THRESHOLD = 0.5;
export const REJECTION_MIN_COUNT = 10;
export const REJECTION_SAMPLE_LIMIT = 5;
export const REJECTION_INPUT_TRUNCATE = 500;

export type RejectionCandidate = {
  toolName: string;
  totalExecuted7d: number;
  totalRejected7d: number;
  rejectionRate: number;
};

// Pure: pick the worst-violating tool (highest rejection count among
// those crossing both thresholds). Returns null if none cross.
export function pickWorstRejectionPattern(
  candidates: RejectionCandidate[],
): RejectionCandidate | null {
  let worst: RejectionCandidate | null = null;
  for (const c of candidates) {
    if (c.rejectionRate < REJECTION_RATE_THRESHOLD) continue;
    if (c.totalRejected7d < REJECTION_MIN_COUNT) continue;
    if (worst === null || c.totalRejected7d > worst.totalRejected7d) {
      worst = c;
    }
  }
  return worst;
}

const RejectionResponseSchema = z.object({
  hypothesis: z.string().min(1).max(400).nullable(),
});

// Pure: parses Flash-Lite's JSON output. Tolerates code fences, returns
// hypothesis string or null. Never throws — the orchestrator must keep
// going even on a malformed LLM response.
export function parseRejectionResponse(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      candidate = JSON.parse(stripped);
    } catch {
      return null;
    }
  }
  const result = RejectionResponseSchema.safeParse(candidate);
  return result.success ? result.data.hypothesis : null;
}

const REJECTION_PROMPT = `You analyze rejected Shopify Merchant Copilot tool calls to spot patterns.

The merchant rejected these tool calls (each is a JSON input the AI tried to apply). Your job: in ONE sentence, name the pattern that explains WHY they were rejected. Examples:

- "Rejected when discount exceeds 30% — operator likely has a max-discount guardrail."
- "Rejected when applied to draft products — operator wants writes only on active SKUs."
- "Rejected when title contains the word 'snowboard' — possibly a fabrication pattern."
- "Rejected on first-message of a conversation — CEO jumping to writes before clarifying intent."

If there's no clear pattern, return null.

Output: JSON object only, no prose.

{ "hypothesis": "one short sentence" }
or
{ "hypothesis": null }

Be conservative. The operator's time is expensive; a wrong pattern misleads more than no pattern.`;

function summarizeToolInput(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return "[unstringifiable input]";
  }
  return json.length > REJECTION_INPUT_TRUNCATE
    ? json.slice(0, REJECTION_INPUT_TRUNCATE) + "…"
    : json;
}

// Pure: builds the user-message body for Flash-Lite. Exported for tests.
export function buildRejectionUserMessage(
  toolName: string,
  inputs: unknown[],
): string {
  const lines = inputs.map(
    (input, i) => `Rejection ${i + 1}: ${summarizeToolInput(input)}`,
  );
  return `Tool: ${toolName}\n\n${lines.join("\n")}\n\nReturn the hypothesis as JSON.`;
}

// Calls Flash-Lite to synthesize a rejection pattern. Returns the
// hypothesis string, or null on any failure (network, schema, rate
// limit). NEVER throws.
async function synthesizeRejectionPattern(
  toolName: string,
  inputs: unknown[],
): Promise<string | null> {
  if (inputs.length === 0) return null;
  try {
    const ai = getGeminiClient();
    const userMessage = buildRejectionUserMessage(toolName, inputs);
    const response = await ai.models.generateContent({
      model: GEMINI_MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: REJECTION_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 256,
      },
    });
    const text = response.text?.trim() ?? "";
    return parseRejectionResponse(text);
  } catch (err) {
    log.warn(
      "system-health: rejection-pattern synthesis failed (non-fatal)",
      {
        toolName,
        err: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

export function buildToolRejectionFinding(
  c: RejectionCandidate,
  hypothesis: string | null,
): RawFinding {
  const ratePct = (c.rejectionRate * 100).toFixed(0);
  return {
    component: "tool_rejection_rate",
    scanName: "toolRejectionPatternScan",
    severity: "warn",
    message: `Tool '${c.toolName}' was rejected ${c.totalRejected7d} of ${c.totalRejected7d + c.totalExecuted7d} times (${ratePct}% rejection rate) over the last 7 days. The CEO is firing it in contexts where the merchant consistently says no.`,
    recommendation: hypothesis
      ? `Pattern: ${hypothesis} Tighten the CEO prompt in app/lib/agent/ceo-prompt/decision-rules.md to either constrain when this tool fires or add a clarifying-question step before proposing the write.`
      : `Inspect the rejected PendingAction rows for '${c.toolName}' (status='REJECTED') to spot the pattern manually. Tighten the CEO prompt in app/lib/agent/ceo-prompt/decision-rules.md to either constrain when this tool fires or add a clarifying-question step.`,
    evidence: {
      toolName: c.toolName,
      totalExecuted7d: c.totalExecuted7d,
      totalRejected7d: c.totalRejected7d,
      rejectionRate: c.rejectionRate,
      llmHypothesis: hypothesis,
      thresholdRate: REJECTION_RATE_THRESHOLD,
      thresholdMinCount: REJECTION_MIN_COUNT,
    },
  };
}

async function toolRejectionPatternScan(opts: {
  storeId: string;
  now: Date;
}): Promise<RawFinding | null> {
  const cutoff = new Date(opts.now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Group executions and rejections per toolName. Use AuditLog because
  // it's the canonical record (PendingAction is mutated, AuditLog is
  // immutable).
  const [executed, rejected] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ["toolName"],
      where: {
        storeId: opts.storeId,
        action: "tool_executed",
        toolName: { not: null },
        createdAt: { gte: cutoff },
      },
      _count: { _all: true },
    }),
    prisma.auditLog.groupBy({
      by: ["toolName"],
      where: {
        storeId: opts.storeId,
        action: "tool_rejected",
        toolName: { not: null },
        createdAt: { gte: cutoff },
      },
      _count: { _all: true },
    }),
  ]);

  const executedByTool = new Map<string, number>();
  for (const r of executed) {
    if (r.toolName) executedByTool.set(r.toolName, r._count._all);
  }

  const candidates: RejectionCandidate[] = [];
  for (const r of rejected) {
    if (!r.toolName) continue;
    const rejCount = r._count._all;
    const exeCount = executedByTool.get(r.toolName) ?? 0;
    const total = rejCount + exeCount;
    if (total === 0) continue;
    candidates.push({
      toolName: r.toolName,
      totalExecuted7d: exeCount,
      totalRejected7d: rejCount,
      rejectionRate: rejCount / total,
    });
  }

  const worst = pickWorstRejectionPattern(candidates);
  if (!worst) return null;

  // Pull the last N rejected PendingAction.toolInput rows for the worst
  // tool. PendingAction is the source of input shapes (AuditLog only
  // has snapshots in `before`/`after` and rejections set `before` to
  // null). Bounded query.
  const samples = await prisma.pendingAction.findMany({
    where: {
      storeId: opts.storeId,
      toolName: worst.toolName,
      status: "REJECTED",
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    take: REJECTION_SAMPLE_LIMIT,
    select: { toolInput: true },
  });
  const inputs = samples.map((s) => s.toolInput);

  const hypothesis = await synthesizeRejectionPattern(worst.toolName, inputs);
  return buildToolRejectionFinding(worst, hypothesis);
}

// Scan registry. Order doesn't matter — orchestrator runs each
// independently with per-scan error catching. Add new scans in
// alphabetical order by component for predictable log output.
const SCANS: Array<{ name: string; fn: ScanFn }> = [
  { name: "embeddingStuckScan", fn: embeddingStuckScan },
  { name: "latencyP95Scan", fn: latencyP95Scan },
  { name: "missingConversationTitleScan", fn: missingConversationTitleScan },
  { name: "staleAnomalyInsightScan", fn: staleAnomalyInsightScan },
  { name: "toolFailureSpikeScan", fn: toolFailureSpikeScan },
  { name: "toolRejectionPatternScan", fn: toolRejectionPatternScan },
];

// Main orchestrator. Called per-store from scripts/run-evaluator.ts.
// Iterates SCANS, applies spam guard, writes findings. Catches errors
// per-scan so one bad scan can't poison the pass.
//
// Returns counters for the cron's console log — telemetry only, no
// behavioral effect.
export async function runSystemHealthScansForStore(opts: {
  storeId: string;
  now: Date;
}): Promise<ScanResult> {
  const result: ScanResult = {
    scansRun: 0,
    findingsFiled: 0,
    skippedSpamGuard: 0,
    errors: 0,
  };

  for (const { name, fn } of SCANS) {
    result.scansRun += 1;
    try {
      const raw = await fn({ storeId: opts.storeId, now: opts.now });
      if (raw === null) continue;

      const eligible = await shouldFileSystemHealthFinding(
        opts.storeId,
        raw.component,
        opts.now,
      );
      if (!eligible) {
        result.skippedSpamGuard += 1;
        continue;
      }

      await fileFinding(opts.storeId, raw);
      result.findingsFiled += 1;
    } catch (err) {
      result.errors += 1;
      log.warn("system-health: scan failed (non-fatal)", {
        scan: name,
        storeId: opts.storeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ----- CRUD for the settings UI -----

// Lists findings for the operator's settings page. Default behavior:
// hide acknowledged, newest first, capped at 100. Tenant-scoped.
export async function listFindings(
  storeId: string,
  opts: { includeAcknowledged?: boolean; limit?: number } = {},
): Promise<FindingRow[]> {
  const limit = opts.limit ?? 100;
  const where = opts.includeAcknowledged
    ? { storeId }
    : { storeId, acknowledgedAt: null };
  const rows = await prisma.systemHealthFinding.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRow);
}

export async function findFindingById(
  storeId: string,
  id: string,
): Promise<FindingRow | null> {
  const row = await prisma.systemHealthFinding.findFirst({
    where: { id, storeId },
  });
  return row ? toRow(row) : null;
}

// Mark a finding acknowledged. Tenant-gated via updateMany (never
// `update({ where: { id } })`) — same defensive pattern as
// insights.server.ts dismissInsight.
export async function acknowledgeFinding(
  storeId: string,
  id: string,
  userEmail: string | null,
): Promise<boolean> {
  const result = await prisma.systemHealthFinding.updateMany({
    where: { id, storeId, acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedBy: userEmail },
  });
  return result.count > 0;
}

// Snooze a finding for N days. Sets snoozedUntil but does NOT
// acknowledge — the operator is saying "remind me later," not "I've
// dealt with this." Snooze-expiry resets spam guard eligibility per
// shouldFileSystemHealthFinding.
export async function snoozeFinding(
  storeId: string,
  id: string,
  days: number,
): Promise<boolean> {
  if (days <= 0 || !Number.isFinite(days)) return false;
  const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const result = await prisma.systemHealthFinding.updateMany({
    where: { id, storeId },
    data: { snoozedUntil },
  });
  return result.count > 0;
}

// Reverse acknowledge + snooze. Used when the operator wants a finding
// back in the open queue.
export async function reopenFinding(
  storeId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.systemHealthFinding.updateMany({
    where: { id, storeId },
    data: { acknowledgedAt: null, acknowledgedBy: null, snoozedUntil: null },
  });
  return result.count > 0;
}

// Test seam: register a scan from a unit test without exporting the
// production SCANS array. Returns a dispose fn. Never used in prod code.
export function __registerScanForTest(
  name: string,
  fn: ScanFn,
): () => void {
  SCANS.push({ name, fn });
  return () => {
    const idx = SCANS.findIndex((s) => s.name === name);
    if (idx >= 0) SCANS.splice(idx, 1);
  };
}
