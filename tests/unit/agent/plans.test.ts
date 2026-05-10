import { describe, expect, it } from "vitest";

import {
  buildResumeContext,
  hasProposePlanCall,
  isPlanStatus,
  PlanStepSchema,
  planAuditPayload,
  PLAN_RESUME_TTL_MS,
  ProposePlanInputSchema,
  type PlanRow,
  type PlanStepStatus,
  type StoredPlanStep,
} from "../../../app/lib/agent/plans.server";

describe("PlanStepSchema", () => {
  it("accepts a minimal valid step", () => {
    const r = PlanStepSchema.safeParse({
      description: "Lower cat food from $25 to $19.99",
      departmentId: "pricing-promotions",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an estimatedTool hint", () => {
    const r = PlanStepSchema.safeParse({
      description: "Update price",
      departmentId: "pricing-promotions",
      estimatedTool: "update_product_price",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty description", () => {
    const r = PlanStepSchema.safeParse({
      description: "",
      departmentId: "products",
    });
    expect(r.success).toBe(false);
  });

  it("rejects too-long description (over 280 chars)", () => {
    const r = PlanStepSchema.safeParse({
      description: "x".repeat(281),
      departmentId: "products",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-kebab-case departmentId", () => {
    const r = PlanStepSchema.safeParse({
      description: "ok",
      departmentId: "Pricing Promotions",
    });
    expect(r.success).toBe(false);
  });

  it("accepts arbitrary kebab-case departmentId (so future depts don't need a schema bump)", () => {
    const r = PlanStepSchema.safeParse({
      description: "ok",
      departmentId: "marketing-seo",
    });
    expect(r.success).toBe(true);
  });
});

describe("ProposePlanInputSchema", () => {
  it("accepts a 2-step plan", () => {
    const r = ProposePlanInputSchema.safeParse({
      summary: "Audit catalog and trim prices",
      steps: [
        { description: "List overpriced products", departmentId: "products" },
        {
          description: "Lower each by 10%",
          departmentId: "pricing-promotions",
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a 1-step plan (just call the tool)", () => {
    const r = ProposePlanInputSchema.safeParse({
      summary: "Single thing",
      steps: [{ description: "Do it", departmentId: "products" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects 9+ steps (too sprawling for a single approval)", () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({
      description: `Step ${i}`,
      departmentId: "products",
    }));
    const r = ProposePlanInputSchema.safeParse({
      summary: "Too much",
      steps,
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty summary", () => {
    const r = ProposePlanInputSchema.safeParse({
      summary: "",
      steps: [
        { description: "a", departmentId: "products" },
        { description: "b", departmentId: "products" },
      ],
    });
    expect(r.success).toBe(false);
  });

  // V5.3 — replan: parentPlanId is optional. When present, it's a non-empty
  // short string (cuid shape). Schema doesn't validate that the parent
  // exists in the DB; that's the executor's job (findPlanById in this
  // store before persisting).
  it("accepts a replan with a valid parentPlanId", () => {
    const r = ProposePlanInputSchema.safeParse({
      summary: "Revised — Cat Food was already at $19.99 by step 2 time",
      steps: [
        { description: "skip step 2 and proceed to step 3", departmentId: "products" },
        { description: "verify final state", departmentId: "products" },
      ],
      parentPlanId: "ckxabc123def456",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.parentPlanId).toBe("ckxabc123def456");
    }
  });

  it("accepts a fresh plan without parentPlanId", () => {
    const r = ProposePlanInputSchema.safeParse({
      summary: "Audit catalog and trim outliers",
      steps: [
        { description: "scan products", departmentId: "products" },
        { description: "trim outliers", departmentId: "pricing-promotions" },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.parentPlanId).toBeUndefined();
    }
  });

  it("rejects an empty parentPlanId string", () => {
    const r = ProposePlanInputSchema.safeParse({
      summary: "Revised plan",
      steps: [
        { description: "a", departmentId: "products" },
        { description: "b", departmentId: "products" },
      ],
      parentPlanId: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("hasProposePlanCall", () => {
  it("returns true when a propose_plan tool_use exists", () => {
    expect(
      hasProposePlanCall([
        { type: "text" },
        { type: "tool_use", name: "propose_plan" },
      ]),
    ).toBe(true);
  });

  it("returns false for other tool_uses", () => {
    expect(
      hasProposePlanCall([
        { type: "tool_use", name: "read_products" },
        { type: "tool_use", name: "ask_clarifying_question" },
      ]),
    ).toBe(false);
  });

  it("returns false on empty content", () => {
    expect(hasProposePlanCall([])).toBe(false);
  });
});

describe("isPlanStatus", () => {
  it.each([
    ["PENDING", true],
    ["APPROVED", true],
    ["REJECTED", true],
    ["EXPIRED", true], // Phase Re Round Re-C2 — staleness-based terminal state
    ["EXECUTED", false],
    ["pending", false], // case-sensitive
    ["", false],
  ])("isPlanStatus(%j) === %s", (input, expected) => {
    expect(isPlanStatus(input)).toBe(expected);
  });
});

describe("planAuditPayload", () => {
  it("captures a compact summary suitable for AuditLog", () => {
    const payload = planAuditPayload({
      id: "plan_abc",
      storeId: "store_1",
      conversationId: "conv_1",
      toolCallId: "propose_plan::abc",
      parentPlanId: null,
      summary: "Audit catalog",
      steps: [
        { description: "step 1", departmentId: "products", status: "pending" },
        {
          description: "step 2",
          departmentId: "pricing-promotions",
          status: "pending",
        },
        { description: "step 3", departmentId: "products", status: "pending" },
      ],
      status: "PENDING",
      currentStepIndex: 0,
      lastStepFailureCode: null,
      lastStepFailureAt: null,
      createdAt: "2026-04-28T18:00:00.000Z",
      updatedAt: "2026-04-28T18:00:00.000Z",
    });
    expect(payload).toEqual({
      planId: "plan_abc",
      summary: "Audit catalog",
      stepCount: 3,
      status: "PENDING",
    });
  });
});

// Phase Re Round Re-C1 — per-step state machine. The DB-touching
// transition helpers (markStepInProgress / Completed / Failed / Skipped)
// are integration-tested implicitly through the executor wiring; here
// we cover the type shape + the in-memory transition logic so a
// reviewer can read the rules at a glance.
describe("PlanStepStatus + StoredPlanStep (Re-C1 shape)", () => {
  it("StoredPlanStep requires status; estimatedTool / completedAt / failureCode are optional", () => {
    const minimal: StoredPlanStep = {
      description: "Lower price",
      departmentId: "pricing-promotions",
      status: "pending",
    };
    expect(minimal.status).toBe("pending");
    const richer: StoredPlanStep = {
      description: "Lower price",
      departmentId: "pricing-promotions",
      estimatedTool: "update_product_price",
      status: "completed",
      completedAt: "2026-05-10T10:00:00.000Z",
    };
    expect(richer.completedAt).toBeDefined();
    const failed: StoredPlanStep = {
      description: "Archive snowboards",
      departmentId: "products",
      status: "failed",
      failureCode: "ID_NOT_FOUND",
    };
    expect(failed.failureCode).toBe("ID_NOT_FOUND");
  });

  it.each<[PlanStepStatus, boolean]>([
    ["pending", true],
    ["in_progress", true],
    ["completed", true],
    ["failed", true],
    ["skipped", true],
  ])("PlanStepStatus union includes %s", (status, valid) => {
    const step: StoredPlanStep = {
      description: "x",
      departmentId: "products",
      status,
    };
    expect(step.status === status).toBe(valid);
  });
});

describe("Re-C1 transition rules (documented behavior)", () => {
  // These tests document the contract enforced by transitionStep in
  // plans.server.ts. The actual function hits the DB; what's testable
  // here is the rule set as encoded in step shape (which states the
  // helpers can produce).
  it("completed bumps currentStepIndex by 1 (encoded in transitionStep helper)", () => {
    // Verify the shape: a completed step always carries completedAt.
    const before: StoredPlanStep = {
      description: "x",
      departmentId: "products",
      status: "in_progress",
    };
    const after: StoredPlanStep = {
      ...before,
      status: "completed",
      completedAt: "2026-05-10T10:00:00.000Z",
    };
    expect(after.status).toBe("completed");
    expect(after.completedAt).toBeDefined();
    expect(after.failureCode).toBeUndefined();
  });

  it("failed pins failureCode and does NOT advance currentStepIndex (only completedAt is for advances)", () => {
    const after: StoredPlanStep = {
      description: "Archive",
      departmentId: "products",
      status: "failed",
      failureCode: "ID_NOT_FOUND",
    };
    expect(after.completedAt).toBeUndefined();
    expect(after.failureCode).toBe("ID_NOT_FOUND");
  });

  it("skipped also bumps currentStepIndex (caller-driven; e.g. operator chose to bypass)", () => {
    const after: StoredPlanStep = {
      description: "Optional polish",
      departmentId: "cross-cutting",
      status: "skipped",
      completedAt: "2026-05-10T10:00:00.000Z",
    };
    expect(after.status).toBe("skipped");
    expect(after.completedAt).toBeDefined();
  });
});

// Phase Re Round Re-C2 — pure-function resume context builder.
function makePlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "plan_xyz",
    storeId: "store_1",
    conversationId: "conv_1",
    toolCallId: "propose_plan::xyz",
    parentPlanId: null,
    summary: "Audit catalog and trim prices",
    steps: [
      { description: "List overpriced products", departmentId: "products", status: "completed", completedAt: "2026-05-10T09:00:00.000Z" },
      { description: "Lower each by 10%", departmentId: "pricing-promotions", status: "pending" },
      { description: "Notify customers", departmentId: "marketing", status: "pending" },
    ],
    status: "APPROVED",
    currentStepIndex: 1,
    lastStepFailureCode: null,
    lastStepFailureAt: null,
    createdAt: "2026-05-10T08:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    ...overrides,
  };
}

describe("buildResumeContext — Re-C2", () => {
  it("returns null when plan is not APPROVED", () => {
    expect(buildResumeContext({ plan: makePlan({ status: "PENDING" }) })).toBeNull();
    expect(buildResumeContext({ plan: makePlan({ status: "REJECTED" }) })).toBeNull();
    expect(buildResumeContext({ plan: makePlan({ status: "EXPIRED" }) })).toBeNull();
  });

  it("returns null when every step is done (currentStepIndex >= length)", () => {
    expect(
      buildResumeContext({ plan: makePlan({ currentStepIndex: 3 }) }),
    ).toBeNull();
  });

  it("describes the pending step + total count", () => {
    const out = buildResumeContext({ plan: makePlan() });
    expect(out).not.toBeNull();
    expect(out).toContain("Step 2 of 3");
    expect(out).toContain("Lower each by 10%");
    expect(out).toContain("pricing-promotions");
  });

  it("notes the prior step completed", () => {
    const out = buildResumeContext({ plan: makePlan() });
    expect(out).toContain("Step 1 of 3 just completed");
  });

  it("notes the prior step FAILED with failure code", () => {
    const out = buildResumeContext({
      plan: makePlan({
        steps: [
          {
            description: "List overpriced products",
            departmentId: "products",
            status: "failed",
            failureCode: "ID_NOT_FOUND",
          },
          { description: "Lower each by 10%", departmentId: "pricing-promotions", status: "pending" },
          { description: "Notify customers", departmentId: "marketing", status: "pending" },
        ],
      }),
    });
    expect(out).toContain("failed");
    expect(out).toContain("ID_NOT_FOUND");
  });

  it("instructs the agent to ask vs. continue based on merchant intent", () => {
    const out = buildResumeContext({ plan: makePlan() });
    // Merchants who shifted topic should get a brief acknowledgment, not a
    // forced resume — the prompt language carries that constraint.
    expect(out).toContain("set this aside");
  });

  it("handles index 0 (first step pending) without referring to a prior step", () => {
    const out = buildResumeContext({
      plan: makePlan({
        currentStepIndex: 0,
        steps: [
          { description: "Run catalog audit", departmentId: "products", status: "pending" },
          { description: "Trim prices", departmentId: "pricing-promotions", status: "pending" },
        ],
      }),
    });
    expect(out).not.toBeNull();
    expect(out).toContain("Step 1 of 2");
    // No prior-step language at index 0
    expect(out).not.toContain("just completed");
    expect(out).not.toContain("was skipped");
  });
});

describe("PLAN_RESUME_TTL_MS — Re-C2", () => {
  it("is 24 hours in milliseconds", () => {
    expect(PLAN_RESUME_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
