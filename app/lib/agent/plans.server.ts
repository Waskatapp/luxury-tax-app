import type { Plan } from "@prisma/client";
import { z } from "zod";

import prisma from "../../db.server";
import { log } from "../log.server";

// V2.3 — Plan-First. Schema, types, and CRUD helpers for the Plan model.
// One row per `propose_plan` tool call. Lifecycle:
//   PENDING → APPROVED  (merchant clicked Approve; CEO proceeds to execute
//                        each step, with each WRITE still gated by its own
//                        ApprovalCard)
//   PENDING → REJECTED  (merchant clicked Reject; CEO acknowledges)
//
// Phase Re Round Re-C1 — per-step state machine added. The plan-level
// PENDING/APPROVED/REJECTED status still tells you whether the merchant
// signed off on the plan as a whole; the new currentStepIndex +
// per-step `status` field tell you which step the agent is executing
// next and which already finished/failed/skipped. This is what enables
// Re-C2's resume-on-next-turn behavior — opening the conversation
// later, the agent can ask "we still had step 3 pending — keep going?"
// instead of restarting from scratch.

// Phase Re Round Re-C2 — EXPIRED is the terminal state for plans whose
// last activity is older than the resume TTL (24h). Assigned lazily by
// expireStalePlans() at agent-loop turn-start so we don't auto-resume
// a 3-day-old half-executed plan when the merchant opens the app
// Monday morning.
export type PlanStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

// Phase Re Round Re-C1 — per-step lifecycle. Step transitions:
//   pending → in_progress (executor dispatches the tool for this step)
//   in_progress → completed (tool returned ok)
//   in_progress → failed   (tool returned non-retryable error)
//   pending     → skipped  (operator/CEO chose to bypass — Re-C2)
// The `currentStepIndex` advances only on completed (and on skipped).
// A failed step blocks: currentStepIndex stays put, lastStepFailureCode
// is populated, and the resume detection in Re-C2 surfaces it.
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export const PLAN_DEPARTMENT_VALUES = [
  "products",
  "pricing-promotions",
  "insights",
  "cross-cutting",
] as const;

export const PlanStepSchema = z.object({
  description: z.string().min(1).max(280),
  // Loose enum so we don't lock the schema to today's three departments —
  // when Phase 3+ adds SEO / Marketing / Customer Operations, the CEO can
  // tag steps without requiring a migration. We still validate against the
  // KNOWN list at prompt-construction time.
  departmentId: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "departmentId must be kebab-case"),
  estimatedTool: z.string().min(1).max(80).optional(),
  // Phase Mn Round Mn-4 — optional phase label for grouping in PlanCard
  // when the plan has 5+ steps (e.g. "Setup", "Pricing", "Marketing").
  // PlanCard renders steps without phase as a flat list; mixing is
  // allowed (steps with no phase render under an "Other" group). Short
  // title-cased labels recommended; agent picks the names.
  phase: z.string().min(1).max(40).optional(),
});

export const ProposePlanInputSchema = z.object({
  summary: z.string().min(1).max(280),
  steps: z.array(PlanStepSchema).min(2).max(8),
  // V5.3 — when the CEO is replanning mid-execution because reality
  // diverged from the original plan's assumptions, it sets parentPlanId
  // to the original Plan's id. The replan is then a fresh row with its
  // own approval flow; the parent stays APPROVED as the historical
  // "what we WOULD have done" record. cuid is the same shape as the
  // existing Plan.id, so we just check it's a non-empty short string.
  parentPlanId: z.string().min(1).max(120).optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type ProposePlanInput = z.infer<typeof ProposePlanInputSchema>;

// Persisted shape of `Plan.steps` JSON. Adds Phase Re Round Re-C1
// per-step status fields. Existing rows backfill via the migration
// (`status: "pending"`); brand-new rows initialize via createPlan().
export type StoredPlanStep = {
  description: string;
  departmentId: string;
  estimatedTool?: string | undefined;
  // Phase Mn Round Mn-4 — optional phase label; see PlanStepSchema.
  phase?: string | undefined;
  status: PlanStepStatus;
  completedAt?: string | undefined;
  failureCode?: string | undefined;
};

export type PlanRow = {
  id: string;
  storeId: string;
  conversationId: string;
  toolCallId: string;
  parentPlanId: string | null;
  summary: string;
  steps: StoredPlanStep[];
  status: PlanStatus;
  // Phase Re Round Re-C1 — per-step pointer + last-failure metadata.
  currentStepIndex: number;
  lastStepFailureCode: string | null;
  lastStepFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(p: Plan): PlanRow {
  // Defensive backfill on read: if a row predates the Re-C1 migration
  // and somehow has steps without a `status` field (shouldn't happen
  // post-migration, but JSON is loose), normalize them to "pending"
  // so downstream code doesn't have to defend against undefined.
  const rawSteps = (p.steps as unknown as Array<Partial<StoredPlanStep>>) ?? [];
  const steps: StoredPlanStep[] = rawSteps.map((s) => ({
    description: s.description ?? "",
    departmentId: s.departmentId ?? "",
    estimatedTool: s.estimatedTool,
    status: s.status ?? "pending",
    completedAt: s.completedAt,
    failureCode: s.failureCode,
  }));
  return {
    id: p.id,
    storeId: p.storeId,
    conversationId: p.conversationId,
    toolCallId: p.toolCallId,
    parentPlanId: p.parentPlanId,
    summary: p.summary,
    steps,
    status: p.status as PlanStatus,
    currentStepIndex: p.currentStepIndex,
    lastStepFailureCode: p.lastStepFailureCode ?? null,
    lastStepFailureAt: p.lastStepFailureAt
      ? p.lastStepFailureAt.toISOString()
      : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// Idempotent create — re-running the propose_plan tool with the same
// `toolCallId` (unique) is a no-op rather than a 500. This matches the
// PendingAction.upsert pattern from Phase 5.
//
// V5.3 — when `parentPlanId` is set, this row is a replan. The caller
// (executor case arm) should validate the parent exists in the same
// store before passing it through, but we don't enforce here — the
// FK constraint on the Plan table catches truly bad ids.
export async function createPlan(opts: {
  storeId: string;
  conversationId: string;
  toolCallId: string;
  summary: string;
  steps: PlanStep[];
  parentPlanId?: string | null;
}): Promise<PlanRow> {
  // Phase Re Round Re-C1 — initialize every step at `pending` so the
  // executor's step-state transitions have something to advance from.
  const stepsWithStatus: StoredPlanStep[] = opts.steps.map((s) => ({
    description: s.description,
    departmentId: s.departmentId,
    estimatedTool: s.estimatedTool,
    status: "pending",
  }));
  const row = await prisma.plan.upsert({
    where: { toolCallId: opts.toolCallId },
    create: {
      storeId: opts.storeId,
      conversationId: opts.conversationId,
      toolCallId: opts.toolCallId,
      parentPlanId: opts.parentPlanId ?? null,
      summary: opts.summary,
      steps: stepsWithStatus as unknown as object,
      status: "PENDING",
      currentStepIndex: 0,
    },
    update: {},
  });
  return toRow(row);
}

// Tenant-scoped lookup by toolCallId. Used by the approve/reject endpoints
// which receive the toolCallId from the client and must verify it belongs
// to the calling store before flipping status.
export async function findPlanByToolCallId(
  storeId: string,
  toolCallId: string,
): Promise<PlanRow | null> {
  const row = await prisma.plan.findFirst({
    where: { toolCallId, storeId },
  });
  return row ? toRow(row) : null;
}

// All Plan rows for a conversation — used by api.messages.tsx to build the
// `planByToolCallId` sidecar so PlanCard knows whether to show
// Approve/Reject buttons or a status badge on reload.
export async function listPlansForConversation(
  storeId: string,
  conversationId: string,
): Promise<PlanRow[]> {
  const rows = await prisma.plan.findMany({
    where: { storeId, conversationId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRow);
}

export type PlanFlipOutcome =
  | { ok: true; status: PlanStatus; alreadyDone: boolean }
  | { ok: false; reason: string };

// Atomic PENDING → target flip via updateMany. updateMany returns
// { count } so concurrent clicks don't both succeed. Returns
// `alreadyDone: true` if the row was already in the target state (idempotent
// retry from the merchant clicking Approve twice on a slow connection).
async function flipPlanStatus(
  storeId: string,
  toolCallId: string,
  target: "APPROVED" | "REJECTED",
): Promise<PlanFlipOutcome> {
  const before = await prisma.plan.findFirst({
    where: { toolCallId, storeId },
    select: { status: true },
  });
  if (!before) return { ok: false, reason: "plan not found" };
  if (before.status === target) {
    return { ok: true, status: target, alreadyDone: true };
  }
  if (before.status !== "PENDING") {
    return {
      ok: false,
      reason: `plan is ${before.status}, not PENDING`,
    };
  }

  const result = await prisma.plan.updateMany({
    where: { toolCallId, storeId, status: "PENDING" },
    data: { status: target },
  });
  if (result.count === 0) {
    // Lost a race — re-read to learn the winning state. Idempotent in
    // the common case (both clicks targeted the same outcome).
    const winner = await prisma.plan.findFirst({
      where: { toolCallId, storeId },
      select: { status: true },
    });
    if (winner?.status === target) {
      return { ok: true, status: target, alreadyDone: true };
    }
    return {
      ok: false,
      reason: `concurrent flip — plan is now ${winner?.status ?? "unknown"}`,
    };
  }
  return { ok: true, status: target, alreadyDone: false };
}

export function approvePlan(
  storeId: string,
  toolCallId: string,
): Promise<PlanFlipOutcome> {
  return flipPlanStatus(storeId, toolCallId, "APPROVED");
}

export function rejectPlan(
  storeId: string,
  toolCallId: string,
): Promise<PlanFlipOutcome> {
  return flipPlanStatus(storeId, toolCallId, "REJECTED");
}

// Helper used by api.chat.tsx and the executor. Returns true if the
// `assistantContent` blocks contain a `propose_plan` tool_use block.
export function hasProposePlanCall(
  blocks: Array<{ type: string; name?: string }>,
): boolean {
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === "propose_plan") return true;
  }
  return false;
}

// Convenience for the audit-log payload. Captures plan summary + step
// count + status — keeps the row searchable without dumping full JSON.
export function planAuditPayload(plan: PlanRow): Record<string, unknown> {
  return {
    planId: plan.id,
    summary: plan.summary,
    stepCount: plan.steps.length,
    status: plan.status,
  };
}

export function isPlanStatus(value: string): value is PlanStatus {
  return (
    value === "PENDING" ||
    value === "APPROVED" ||
    value === "REJECTED" ||
    value === "EXPIRED"
  );
}

// Best-effort convenience for the executor — never throws, logs and
// returns null on failure. The CEO's tool_result block synthesis tolerates
// nulls (treats them as "plan persisted but id unavailable", which is
// recoverable on the next turn).
export async function safeCreatePlan(opts: {
  storeId: string;
  conversationId: string;
  toolCallId: string;
  summary: string;
  steps: PlanStep[];
  parentPlanId?: string | null;
}): Promise<PlanRow | null> {
  try {
    return await createPlan(opts);
  } catch (err) {
    log.error("safeCreatePlan failed", { err, toolCallId: opts.toolCallId });
    return null;
  }
}

// V5.3 — tenant-scoped fetch by id. Used by the executor to verify a
// claimed parentPlanId exists in this store before persisting a replan.
// Cheap and bounded: a single indexed lookup on the primary key + storeId.
export async function findPlanById(
  storeId: string,
  id: string,
): Promise<PlanRow | null> {
  const row = await prisma.plan.findFirst({
    where: { id, storeId },
  });
  return row ? toRow(row) : null;
}

// Phase Re Round Re-C1 — find the active APPROVED plan for a
// conversation, if any. Active = APPROVED status + currentStepIndex
// hasn't reached step count. Used by the executor to decide whether
// a tool dispatch is part of a plan step (and which step). Returns
// null when there's no plan, the plan is PENDING/REJECTED/EXPIRED, or
// every step is already completed/skipped.
//
// IMPORTANT: when multiple APPROVED plans exist on the same
// conversation (e.g., merchant approved a replan after the original),
// returns the most-recently-updated one. Step-advance only fires on
// THE active plan; older approved-but-superseded plans don't advance.
export async function findActivePlan(
  storeId: string,
  conversationId: string,
): Promise<PlanRow | null> {
  const rows = await prisma.plan.findMany({
    where: { storeId, conversationId, status: "APPROVED" },
    orderBy: { updatedAt: "desc" },
    take: 5, // bound the scan; reading 5 plans is cheap
  });
  for (const r of rows) {
    const row = toRow(r);
    if (row.currentStepIndex < row.steps.length) {
      return row;
    }
  }
  return null;
}

// Phase Re Round Re-C2 — resume TTL. Plans whose last activity is older
// than this don't auto-resume — the merchant has presumably moved on.
// 24 hours matches Re-C2's stop-condition criteria; if false-positive
// resumes turn out to be a problem we drop this to 1h per the plan's
// "stop conditions" section.
export const PLAN_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

// Mark APPROVED plans whose updatedAt is older than the resume TTL as
// EXPIRED. Best-effort: any DB error is swallowed so a hiccup here can't
// block the agent loop. Runs at agent-loop turn-start.
export async function expireStalePlans(opts: {
  storeId: string;
  conversationId: string;
  now: Date;
}): Promise<number> {
  const cutoff = new Date(opts.now.getTime() - PLAN_RESUME_TTL_MS);
  try {
    const result = await prisma.plan.updateMany({
      where: {
        storeId: opts.storeId,
        conversationId: opts.conversationId,
        status: "APPROVED",
        updatedAt: { lt: cutoff },
      },
      data: { status: "EXPIRED" },
    });
    if (result.count > 0) {
      log.info("expired stale APPROVED plans", {
        storeId: opts.storeId,
        conversationId: opts.conversationId,
        count: result.count,
        cutoffIso: cutoff.toISOString(),
      });
    }
    return result.count;
  } catch (err) {
    log.error("expireStalePlans failed", {
      storeId: opts.storeId,
      conversationId: opts.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// Phase Re Round Re-C2 — pure-function helper that crafts the resume
// context blurb for the CEO's system instruction. Tested independently
// of DB so the wording can evolve without integration-testing.
//
// Returns null when there's nothing to resume (no plan, all steps done,
// or stale steps that should be ignored). Otherwise returns a single
// short paragraph the agent-loop appends to the systemInstruction.
export function buildResumeContext(opts: {
  plan: PlanRow;
}): string | null {
  const plan = opts.plan;
  if (plan.status !== "APPROVED") return null;
  if (plan.currentStepIndex >= plan.steps.length) return null;
  const step = plan.steps[plan.currentStepIndex];
  const stepNum = plan.currentStepIndex + 1;
  const totalSteps = plan.steps.length;

  // Describe what the previous step did (if any) so the agent can frame
  // the resume cleanly. Uses index-1 since the CURRENT step is what's
  // pending, not what just happened.
  let priorContext = "";
  if (plan.currentStepIndex > 0) {
    const prior = plan.steps[plan.currentStepIndex - 1];
    if (prior.status === "failed") {
      priorContext = ` The previous step (${plan.currentStepIndex} of ${totalSteps}) failed${
        prior.failureCode ? ` (${prior.failureCode})` : ""
      }.`;
    } else if (prior.status === "completed") {
      priorContext = ` Step ${plan.currentStepIndex} of ${totalSteps} just completed.`;
    } else if (prior.status === "skipped") {
      priorContext = ` Step ${plan.currentStepIndex} of ${totalSteps} was skipped.`;
    }
  }

  return (
    `Active plan: "${plan.summary}". Step ${stepNum} of ${totalSteps} is pending: ` +
    `"${step.description}" (department: ${step.departmentId}).${priorContext} ` +
    `If the merchant's current message clearly relates to this plan, ` +
    `continue executing. If the merchant has shifted topic, briefly ` +
    `surface the pending step ("we still have step ${stepNum} pending — ` +
    `keep going or set this aside?") then follow their lead.`
  );
}

// Phase Re Round Re-C1 — atomically advance a step to a new status.
// Uses an updateMany with a guard on the expected currentStepIndex so
// concurrent dispatches (rare but possible) don't double-advance. The
// caller passes the planId + the index they observed; if the index has
// already moved (another dispatch won the race), this is a no-op and
// returns false.
//
// Step transitions allowed:
//   pending → in_progress
//   in_progress → completed (advances currentStepIndex)
//   in_progress → failed   (does NOT advance; pins lastStepFailure*)
//   pending → skipped      (advances currentStepIndex)
//
// On `completed`/`skipped`, currentStepIndex bumps by 1.
// On `failed`, currentStepIndex stays put — Re-C2's resume detection
// uses lastStepFailureCode to surface the block to the merchant.
async function transitionStep(opts: {
  planId: string;
  storeId: string;
  expectedIndex: number;
  newStatus: Exclude<PlanStepStatus, "pending">;
  failureCode?: string;
}): Promise<boolean> {
  // Read-modify-write would race; instead, do a guarded single-update
  // by reading the row, computing the new steps array, then updating
  // with a `where: { currentStepIndex: expectedIndex }` clause that
  // makes the update atomic.
  const plan = await prisma.plan.findFirst({
    where: { id: opts.planId, storeId: opts.storeId },
    select: { steps: true, currentStepIndex: true },
  });
  if (!plan) return false;
  if (plan.currentStepIndex !== opts.expectedIndex) return false;

  const steps = (plan.steps as unknown as StoredPlanStep[]).slice();
  if (opts.expectedIndex < 0 || opts.expectedIndex >= steps.length) {
    return false;
  }
  const target = steps[opts.expectedIndex];
  const updated: StoredPlanStep = { ...target, status: opts.newStatus };
  if (opts.newStatus === "completed" || opts.newStatus === "skipped") {
    updated.completedAt = new Date().toISOString();
  }
  if (opts.newStatus === "failed" && opts.failureCode) {
    updated.failureCode = opts.failureCode;
  }
  steps[opts.expectedIndex] = updated;

  const advance =
    opts.newStatus === "completed" || opts.newStatus === "skipped";
  const data: {
    steps: object;
    currentStepIndex?: number;
    lastStepFailureCode?: string | null;
    lastStepFailureAt?: Date | null;
  } = {
    steps: steps as unknown as object,
  };
  if (advance) data.currentStepIndex = opts.expectedIndex + 1;
  if (opts.newStatus === "failed") {
    data.lastStepFailureCode = opts.failureCode ?? "UNKNOWN";
    data.lastStepFailureAt = new Date();
  }

  // Atomic guard: only update if currentStepIndex still matches what we
  // observed. If a concurrent dispatch advanced it first, we no-op.
  const result = await prisma.plan.updateMany({
    where: {
      id: opts.planId,
      storeId: opts.storeId,
      currentStepIndex: opts.expectedIndex,
    },
    data,
  });
  return result.count > 0;
}

export function markStepInProgress(opts: {
  planId: string;
  storeId: string;
  expectedIndex: number;
}): Promise<boolean> {
  return transitionStep({ ...opts, newStatus: "in_progress" });
}

export function markStepCompleted(opts: {
  planId: string;
  storeId: string;
  expectedIndex: number;
}): Promise<boolean> {
  return transitionStep({ ...opts, newStatus: "completed" });
}

export function markStepFailed(opts: {
  planId: string;
  storeId: string;
  expectedIndex: number;
  failureCode: string;
}): Promise<boolean> {
  return transitionStep({
    planId: opts.planId,
    storeId: opts.storeId,
    expectedIndex: opts.expectedIndex,
    newStatus: "failed",
    failureCode: opts.failureCode,
  });
}

export function markStepSkipped(opts: {
  planId: string;
  storeId: string;
  expectedIndex: number;
}): Promise<boolean> {
  return transitionStep({ ...opts, newStatus: "skipped" });
}
