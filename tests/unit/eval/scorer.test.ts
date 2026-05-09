import { describe, expect, it } from "vitest";

import { scoreScenario } from "../../../app/lib/eval/scorer";
import type { EvalObservation } from "../../../app/lib/eval/types";

function obs(overrides: Partial<EvalObservation> = {}): EvalObservation {
  return {
    assistantText: "",
    toolNamesUsed: [],
    outcome: "informational",
    ceoConfidence: null,
    ranOutOfAdminResponses: false,
    loopError: null,
    ...overrides,
  };
}

describe("scoreScenario — empty expectation", () => {
  it("passes when no constraints are set", () => {
    const r = scoreScenario({}, obs());
    expect(r.passed).toBe(true);
    expect(r.failedExpectations).toEqual([]);
  });

  it("still fails when the loop crashed even with no expectation", () => {
    const r = scoreScenario({}, obs({ loopError: "boom" }));
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("loop crashed");
  });

  it("still fails when fakeAdmin ran out of responses", () => {
    const r = scoreScenario({}, obs({ ranOutOfAdminResponses: true }));
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("ran out");
  });
});

describe("scoreScenario — mustCallTool", () => {
  it("passes when required tool is in toolNamesUsed", () => {
    const r = scoreScenario(
      { mustCallTool: ["read_products"] },
      obs({ toolNamesUsed: ["read_products"] }),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when required tool is missing — diagnostic shows what was actually called", () => {
    const r = scoreScenario(
      { mustCallTool: ["read_products"] },
      obs({ toolNamesUsed: ["delegate_to_department"] }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("read_products");
    expect(r.failedExpectations[0]).toContain("delegate_to_department");
  });

  it("fails with 'none' diagnostic when no tools were called at all", () => {
    const r = scoreScenario(
      { mustCallTool: ["read_products"] },
      obs({ toolNamesUsed: [] }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("none");
  });

  it("requires ALL tools when multiple — partial match fails", () => {
    const r = scoreScenario(
      { mustCallTool: ["read_products", "delegate_to_department"] },
      obs({ toolNamesUsed: ["read_products"] }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations).toHaveLength(1);
    expect(r.failedExpectations[0]).toContain("delegate_to_department");
  });
});

describe("scoreScenario — mustNotCallTool", () => {
  it("passes when forbidden tool is absent", () => {
    const r = scoreScenario(
      { mustNotCallTool: ["update_product_price"] },
      obs({ toolNamesUsed: ["read_products"] }),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when forbidden tool was called", () => {
    const r = scoreScenario(
      { mustNotCallTool: ["update_product_price"] },
      obs({ toolNamesUsed: ["update_product_price"] }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("update_product_price");
    expect(r.failedExpectations[0]).toContain("NOT");
  });
});

describe("scoreScenario — outcome", () => {
  it("passes when outcome matches", () => {
    const r = scoreScenario(
      { outcomeShouldBe: "informational" },
      obs({ outcome: "informational" }),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when outcome differs", () => {
    const r = scoreScenario(
      { outcomeShouldBe: "approved" },
      obs({ outcome: "rejected" }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("rejected");
    expect(r.failedExpectations[0]).toContain("approved");
  });
});

describe("scoreScenario — mustContainText (case-insensitive)", () => {
  it("matches substring case-insensitively", () => {
    const r = scoreScenario(
      { mustContainText: ["low stock"] },
      obs({ assistantText: "You have 3 SKUs flagged with LOW STOCK." }),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when substring is absent", () => {
    const r = scoreScenario(
      { mustContainText: ["low stock"] },
      obs({ assistantText: "All inventory levels look healthy." }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("low stock");
  });

  it("requires ALL substrings when multiple", () => {
    const r = scoreScenario(
      { mustContainText: ["snowboard", "winter"] },
      obs({ assistantText: "I rebuilt the snowboard description." }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations).toHaveLength(1);
    expect(r.failedExpectations[0]).toContain("winter");
  });
});

describe("scoreScenario — confidenceFloor", () => {
  it("passes when confidence is at or above floor", () => {
    const r = scoreScenario(
      { confidenceFloor: 0.5 },
      obs({ ceoConfidence: 0.6 }),
    );
    expect(r.passed).toBe(true);
  });

  it("fails when confidence below floor", () => {
    const r = scoreScenario(
      { confidenceFloor: 0.7 },
      obs({ ceoConfidence: 0.4 }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("0.40");
    expect(r.failedExpectations[0]).toContain("0.70");
  });

  it("fails when no confidence tag was emitted but a floor is required", () => {
    const r = scoreScenario(
      { confidenceFloor: 0.5 },
      obs({ ceoConfidence: null }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations[0]).toContain("no Confidence tag");
  });

  it("treats confidenceFloor: 0 as no constraint (passes any value including null)", () => {
    expect(
      scoreScenario({ confidenceFloor: 0 }, obs({ ceoConfidence: null })).passed,
    ).toBe(true);
    expect(
      scoreScenario({ confidenceFloor: 0 }, obs({ ceoConfidence: 0.3 })).passed,
    ).toBe(true);
  });
});

describe("scoreScenario — multi-failure aggregation", () => {
  it("collects every failed expectation in order", () => {
    const r = scoreScenario(
      {
        mustCallTool: ["read_products"],
        mustNotCallTool: ["update_product_price"],
        outcomeShouldBe: "approved",
        mustContainText: ["snowboard"],
      },
      obs({
        toolNamesUsed: ["update_product_price"],
        outcome: "rejected",
        assistantText: "all done",
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedExpectations).toHaveLength(4);
  });
});
