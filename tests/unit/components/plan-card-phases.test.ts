import { describe, expect, it } from "vitest";

import {
  groupStepsByPhase,
  type PlanStep,
} from "../../../app/components/chat/PlanCard";

// Phase Mn Round Mn-4 — groupStepsByPhase is the pure helper PlanCard
// uses to render steps in named phase groups. Unit tests cover the
// grouping contract; UI integration is verified manually in dev.

function step(over: Partial<PlanStep>): PlanStep {
  return {
    description: "step",
    departmentId: "products",
    ...over,
  };
}

describe("groupStepsByPhase", () => {
  it("returns an empty array for empty input", () => {
    expect(groupStepsByPhase([])).toEqual([]);
  });

  it("returns one ungrouped group when no step carries a phase", () => {
    const groups = groupStepsByPhase([
      step({ description: "a" }),
      step({ description: "b" }),
      step({ description: "c" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].phase).toBeNull();
    expect(groups[0].steps).toHaveLength(3);
    expect(groups[0].steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("groups consecutive same-phase steps under one heading", () => {
    const groups = groupStepsByPhase([
      step({ description: "a", phase: "Setup" }),
      step({ description: "b", phase: "Setup" }),
      step({ description: "c", phase: "Pricing" }),
      step({ description: "d", phase: "Pricing" }),
      step({ description: "e", phase: "Launch" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].phase).toBe("Setup");
    expect(groups[0].steps.map((s) => s.step.description)).toEqual(["a", "b"]);
    expect(groups[1].phase).toBe("Pricing");
    expect(groups[1].steps.map((s) => s.step.description)).toEqual(["c", "d"]);
    expect(groups[2].phase).toBe("Launch");
    expect(groups[2].steps.map((s) => s.step.description)).toEqual(["e"]);
  });

  it("preserves global index across groups", () => {
    const groups = groupStepsByPhase([
      step({ description: "a", phase: "Setup" }),
      step({ description: "b", phase: "Pricing" }),
      step({ description: "c", phase: "Pricing" }),
    ]);
    expect(groups[0].steps[0].index).toBe(0);
    expect(groups[1].steps[0].index).toBe(1);
    expect(groups[1].steps[1].index).toBe(2);
  });

  it("mixes phased and unphased steps into separate groups (no-phase boundary)", () => {
    const groups = groupStepsByPhase([
      step({ description: "a", phase: "Setup" }),
      step({ description: "b" }),
      step({ description: "c", phase: "Pricing" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].phase).toBe("Setup");
    expect(groups[1].phase).toBeNull();
    expect(groups[1].steps[0].index).toBe(1);
    expect(groups[2].phase).toBe("Pricing");
  });

  it("doesn't merge non-consecutive same-phase groups (preserves agent's intent)", () => {
    const groups = groupStepsByPhase([
      step({ description: "a", phase: "Setup" }),
      step({ description: "b", phase: "Pricing" }),
      step({ description: "c", phase: "Setup" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].phase).toBe("Setup");
    expect(groups[1].phase).toBe("Pricing");
    expect(groups[2].phase).toBe("Setup");
  });
});
