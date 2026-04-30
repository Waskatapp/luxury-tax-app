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
// We deliberately don't track step-level state in this model. Each step
// becomes a separate tool call as the CEO works through the plan; those
// tool calls already have their own AuditLog rows + PendingAction rows.
// Bringing step-level state here would just duplicate that.

export type PlanStatus = "PENDING" | "APPROVED" | "REJECTED";

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

// Persisted shape of `Plan.steps` JSON. Identical to PlanStep but
// re-declared so callers don't need to import the Zod-derived type
// just to read a row.
export type StoredPlanStep = {
  description: string;
  departmentId: string;
  estimatedTool?: string | undefined;
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
  createdAt: string;
  updatedAt: string;
};

function toRow(p: Plan): PlanRow {
  return {
    id: p.id,
    storeId: p.storeId,
    conversationId: p.conversationId,
    toolCallId: p.toolCallId,
    parentPlanId: p.parentPlanId,
    summary: p.summary,
    steps: (p.steps as unknown as StoredPlanStep[]) ?? [],
    status: p.status as PlanStatus,
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
  const row = await prisma.plan.upsert({
    where: { toolCallId: opts.toolCallId },
    create: {
      storeId: opts.storeId,
      conversationId: opts.conversationId,
      toolCallId: opts.toolCallId,
      parentPlanId: opts.parentPlanId ?? null,
      summary: opts.summary,
      steps: opts.steps as unknown as object,
      status: "PENDING",
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
  return value === "PENDING" || value === "APPROVED" || value === "REJECTED";
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
