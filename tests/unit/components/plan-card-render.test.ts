import { describe, expect, it } from "vitest";

import { shouldRenderPlanCard } from "../../../app/components/chat/PlanCard";

// Regression for the live-testing UX bug: when Gemini sends propose_plan
// with > 8 steps (or otherwise invalid input), the executor's Zod
// validation rejects it and no Plan row is created. Without this guard
// the message bubble was rendering a phantom Approve/Reject card backed
// by no Plan — clicking Approve would 404, AND it visually contradicted
// the CEO's follow-up text already explaining the plan was rejected.

describe("shouldRenderPlanCard", () => {
  it("renders when sidecar exists (server confirmed Plan row)", () => {
    expect(shouldRenderPlanCard({ hasSidecar: true, inputStepCount: 0 })).toBe(true);
    expect(shouldRenderPlanCard({ hasSidecar: true, inputStepCount: 28 })).toBe(true);
  });

  it("renders mid-stream when sidecar is missing but input step count is valid (2-8)", () => {
    // The brief window after the SSE stream emits the tool_use block
    // but before reloadMessages() round-trips the sidecar.
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 2 })).toBe(true);
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 5 })).toBe(true);
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 8 })).toBe(true);
  });

  it("suppresses phantom card when no sidecar AND step count exceeds the cap", () => {
    // The 28-step case from live testing.
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 28 })).toBe(false);
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 9 })).toBe(false);
  });

  it("suppresses phantom card when no sidecar AND step count is below the floor", () => {
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 0 })).toBe(false);
    expect(shouldRenderPlanCard({ hasSidecar: false, inputStepCount: 1 })).toBe(false);
  });
});
