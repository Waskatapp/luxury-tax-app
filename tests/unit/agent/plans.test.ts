import { describe, expect, it } from "vitest";

import {
  hasProposePlanCall,
  isPlanStatus,
  PlanStepSchema,
  planAuditPayload,
  ProposePlanInputSchema,
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
      summary: "Audit catalog",
      steps: [
        { description: "step 1", departmentId: "products" },
        { description: "step 2", departmentId: "pricing-promotions" },
        { description: "step 3", departmentId: "products" },
      ],
      status: "PENDING",
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
