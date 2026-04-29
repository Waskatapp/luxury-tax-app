import type { ActionFollowup } from "@prisma/client";
import { z } from "zod";

import prisma from "../../db.server";
import { log } from "../log.server";
import {
  safeCreateDecision,
  synthesizeExpectedOutcome,
  type DecisionCategory,
} from "./decisions.server";

// V3.1 — Phase 3 Autonomous Reasoning Loop. Schema, types, and CRUD for the
// ActionFollowup model. One row per "I'll check this later" commitment the
// CEO makes after an outcome-bearing write.
//
// Lifecycle: PENDING → EVALUATED | ABANDONED. The offline evaluator
// (.github/workflows/followup-evaluator.yml, ships in 3.2) flips them.
//
// The CEO writes `evaluationCriteria` per action — the criteria are a CEO
// judgment, NOT a fixed schedule. High-traffic SKU may use min_sessions: 200;
// slow movers min_days: 60. The merchant has explicitly stated nothing here
// should be static — every threshold is per-action CEO reasoning.

export type FollowupStatus = "PENDING" | "EVALUATED" | "ABANDONED";

export const METRIC_VALUES = [
  "conversion_rate",
  "revenue",
  "sessions",
  "units_sold",
  "aov",
  "inventory_at_risk",
] as const;
export type FollowupMetric = (typeof METRIC_VALUES)[number];

export const EXPECTED_DIRECTION_VALUES = ["lift", "drop", "neutral"] as const;
export type ExpectedDirection = (typeof EXPECTED_DIRECTION_VALUES)[number];

// CEO-decided evaluation criteria. At least one of min_sessions / min_days
// must be set (a followup with no signal threshold makes no sense). max_days
// is the hard abandon stop. min_units / min_orders allow gating on
// transaction volume instead of session traffic when that's the meaningful
// signal (low-traffic high-AOV products care about orders, not sessions).
export const EvaluationCriteriaSchema = z
  .object({
    min_sessions: z.number().int().min(1).max(1_000_000).optional(),
    min_days: z.number().int().min(1).max(365).optional(),
    max_days: z.number().int().min(1).max(365),
    min_units: z.number().int().min(1).max(100_000).optional(),
    min_orders: z.number().int().min(1).max(100_000).optional(),
  })
  .refine(
    (c) => c.min_sessions !== undefined || c.min_days !== undefined,
    "At least one of min_sessions or min_days must be set",
  )
  .refine(
    (c) => c.min_days === undefined || c.min_days <= c.max_days,
    "min_days must be <= max_days",
  );
export type EvaluationCriteria = z.infer<typeof EvaluationCriteriaSchema>;

// Untyped JSON for the snapshot — its shape varies by metric. The evaluator
// (3.2) owns the per-metric deserialization and significance math. Common
// shapes:
//   conversion_rate: { sessions, conversions, asOf }
//   revenue:         { revenue, currency, asOf }
//   units_sold:      { units, asOf }
export const BaselineSnapshotSchema = z.record(z.string(), z.unknown());
export type BaselineSnapshot = z.infer<typeof BaselineSnapshotSchema>;

export const ProposeFollowupInputSchema = z.object({
  productId: z.string().min(1).max(200).optional(),
  metric: z.enum(METRIC_VALUES),
  hypothesis: z.string().min(1).max(500),
  expectedDirection: z.enum(EXPECTED_DIRECTION_VALUES),
  expectedEffectPct: z.number().min(-100).max(1000).optional(),
  baselineSnapshot: BaselineSnapshotSchema,
  evaluationCriteria: EvaluationCriteriaSchema,
  // Optional links — populated when the followup is spawned by a write
  // tool. propose_followup may be called standalone too (e.g. "check
  // overall store conversion in 2 weeks").
  auditLogId: z.string().optional(),
  toolCallId: z.string().optional(),
});
export type ProposeFollowupInput = z.infer<typeof ProposeFollowupInputSchema>;

export type FollowupRow = {
  id: string;
  storeId: string;
  conversationId: string | null;
  auditLogId: string | null;
  toolCallId: string | null;
  productId: string | null;
  metric: FollowupMetric;
  hypothesis: string;
  expectedDirection: ExpectedDirection;
  expectedEffectPct: number | null;
  baselineSnapshot: BaselineSnapshot;
  evaluationCriteria: EvaluationCriteria;
  status: FollowupStatus;
  dueAt: string;
  abandonAt: string;
  evaluatedAt: string | null;
  insightId: string | null;
  createdAt: string;
};

function toRow(f: ActionFollowup): FollowupRow {
  return {
    id: f.id,
    storeId: f.storeId,
    conversationId: f.conversationId,
    auditLogId: f.auditLogId,
    toolCallId: f.toolCallId,
    productId: f.productId,
    metric: f.metric as FollowupMetric,
    hypothesis: f.hypothesis,
    expectedDirection: f.expectedDirection as ExpectedDirection,
    expectedEffectPct: f.expectedEffectPct,
    baselineSnapshot: f.baselineSnapshot as unknown as BaselineSnapshot,
    evaluationCriteria: f.evaluationCriteria as unknown as EvaluationCriteria,
    status: f.status as FollowupStatus,
    dueAt: f.dueAt.toISOString(),
    abandonAt: f.abandonAt.toISOString(),
    evaluatedAt: f.evaluatedAt?.toISOString() ?? null,
    insightId: f.insightId,
    createdAt: f.createdAt.toISOString(),
  };
}

export const DEFAULT_GRACE_DAYS = 7;

// Pure function: compute due date / abandon date from criteria + a creation
// time. Tests exercise this without touching the DB.
//
// dueAt = createdAt + min_days (or createdAt itself if min_days is unset;
//         the cron then gates on min_sessions / min_units / min_orders).
// abandonAt = createdAt + max_days + grace.
export function computeDueDates(opts: {
  criteria: EvaluationCriteria;
  createdAt: Date;
  graceDays?: number;
}): { dueAt: Date; abandonAt: Date } {
  const { criteria, createdAt } = opts;
  const grace = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const minDays = criteria.min_days ?? 0;
  const dueAt = new Date(createdAt.getTime() + minDays * 24 * 3600 * 1000);
  const abandonAt = new Date(
    createdAt.getTime() + (criteria.max_days + grace) * 24 * 3600 * 1000,
  );
  return { dueAt, abandonAt };
}

export async function createFollowup(opts: {
  storeId: string;
  conversationId?: string | null;
  input: ProposeFollowupInput;
}): Promise<FollowupRow> {
  const createdAt = new Date();
  const { dueAt, abandonAt } = computeDueDates({
    criteria: opts.input.evaluationCriteria,
    createdAt,
  });
  const row = await prisma.actionFollowup.create({
    data: {
      storeId: opts.storeId,
      conversationId: opts.conversationId ?? null,
      auditLogId: opts.input.auditLogId ?? null,
      toolCallId: opts.input.toolCallId ?? null,
      productId: opts.input.productId ?? null,
      metric: opts.input.metric,
      hypothesis: opts.input.hypothesis,
      expectedDirection: opts.input.expectedDirection,
      expectedEffectPct: opts.input.expectedEffectPct ?? null,
      baselineSnapshot: opts.input.baselineSnapshot as unknown as object,
      evaluationCriteria: opts.input.evaluationCriteria as unknown as object,
      status: "PENDING",
      dueAt,
      abandonAt,
      createdAt,
    },
  });

  // V4.1 — Every followup gets a Decision twin. Best-effort: if the
  // Decision write fails the followup still stands (the journal is
  // valuable but not load-bearing for the user-facing flow). The
  // evaluator (3.2) will fill in actualOutcome on this Decision when
  // the followup matures via the @unique followupId link.
  await safeCreateDecision({
    storeId: opts.storeId,
    followupId: row.id,
    auditLogId: opts.input.auditLogId ?? null,
    conversationId: opts.conversationId ?? null,
    productId: opts.input.productId ?? null,
    category: opts.input.metric as DecisionCategory,
    hypothesis: opts.input.hypothesis,
    expectedOutcome: synthesizeExpectedOutcome({
      expectedDirection: opts.input.expectedDirection,
      expectedEffectPct: opts.input.expectedEffectPct ?? null,
      metric: opts.input.metric,
    }),
  });

  return toRow(row);
}

// Best-effort wrapper for the executor — never throws. Mirrors
// safeCreatePlan / safeCreateArtifact.
export async function safeCreateFollowup(opts: {
  storeId: string;
  conversationId?: string | null;
  input: ProposeFollowupInput;
}): Promise<FollowupRow | null> {
  try {
    return await createFollowup(opts);
  } catch (err) {
    log.error("safeCreateFollowup failed", {
      err,
      storeId: opts.storeId,
      productId: opts.input.productId,
    });
    return null;
  }
}

export async function findFollowupById(
  storeId: string,
  id: string,
): Promise<FollowupRow | null> {
  const row = await prisma.actionFollowup.findFirst({
    where: { id, storeId },
  });
  return row ? toRow(row) : null;
}

export async function listPendingFollowupsForStore(
  storeId: string,
  limit = 100,
): Promise<FollowupRow[]> {
  const rows = await prisma.actionFollowup.findMany({
    where: { storeId, status: "PENDING" },
    orderBy: { dueAt: "asc" },
    take: limit,
  });
  return rows.map(toRow);
}

// Used by the offline evaluator (3.2) — selects rows that are due across
// every store. No store-scope filter; this is the cron path. The shared
// index `[storeId, status, dueAt]` still serves the query because Postgres
// can use it as a leading-column scan when storeId is unconstrained.
export async function listDueFollowupsAcrossStores(
  now: Date,
  limit = 500,
): Promise<FollowupRow[]> {
  const rows = await prisma.actionFollowup.findMany({
    where: {
      status: "PENDING",
      dueAt: { lte: now },
    },
    orderBy: { dueAt: "asc" },
    take: limit,
  });
  return rows.map(toRow);
}

// Compact summary for the propose_followup tool_result. Token-cheap;
// Gemini only needs to know the followup was queued and when it'll be
// evaluated.
export function followupSummary(f: FollowupRow): {
  followupId: string;
  metric: FollowupMetric;
  hypothesis: string;
  dueAt: string;
  abandonAt: string;
} {
  return {
    followupId: f.id,
    metric: f.metric,
    hypothesis: f.hypothesis,
    dueAt: f.dueAt,
    abandonAt: f.abandonAt,
  };
}

export function isFollowupStatus(value: string): value is FollowupStatus {
  return (
    value === "PENDING" || value === "EVALUATED" || value === "ABANDONED"
  );
}
