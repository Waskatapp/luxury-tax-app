import { describe, expect, it } from "vitest";

import {
  cosineSimilarity,
  formatDecisionForPrompt,
  formatDecisionsAsMarkdown,
  synthesizeExpectedOutcome,
  type SimilarDecision,
} from "../../../app/lib/agent/decisions.server";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6);
  });

  it("is direction-invariant — magnitude doesn't change result", () => {
    // Cosine ignores magnitude; only direction matters.
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // same direction, 2x magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
  });

  it("returns 0 for mismatched dimensions (defensive — should never happen with text-embedding-004)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 when either vector is all zeros (denominator is 0)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("computes a sensible mid-value for partially-aligned vectors", () => {
    // [1, 1] and [1, 0] form a 45° angle, cos ≈ 0.707.
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe("synthesizeExpectedOutcome", () => {
  it("formats a lift with effect %", () => {
    const s = synthesizeExpectedOutcome({
      expectedDirection: "lift",
      expectedEffectPct: 5,
      metric: "conversion_rate",
    });
    expect(s).toContain("5%");
    expect(s).toContain("lift");
    expect(s).toContain("conversion_rate");
  });

  it("formats a drop with effect %", () => {
    const s = synthesizeExpectedOutcome({
      expectedDirection: "drop",
      expectedEffectPct: 10,
      metric: "revenue",
    });
    expect(s).toContain("10%");
    expect(s).toContain("drop");
    expect(s).toContain("revenue");
  });

  it("uses absolute value for effectPct so 'lift -5' doesn't become '-5% lift'", () => {
    // Edge case: CEO might pass a signed expectedEffectPct. We always
    // format the magnitude and let direction speak for the sign.
    const s = synthesizeExpectedOutcome({
      expectedDirection: "drop",
      expectedEffectPct: -10,
      metric: "revenue",
    });
    expect(s).toContain("10%");
    expect(s).not.toContain("-10");
  });

  it("falls back to qualitative phrasing when effectPct is null", () => {
    const s = synthesizeExpectedOutcome({
      expectedDirection: "lift",
      expectedEffectPct: null,
      metric: "conversion_rate",
    });
    expect(s).toContain("lift");
    expect(s).not.toContain("%");
  });

  it("handles neutral direction explicitly", () => {
    const s = synthesizeExpectedOutcome({
      expectedDirection: "neutral",
      expectedEffectPct: null,
      metric: "conversion_rate",
    });
    expect(s).toMatch(/no significant change|neutral|stay/i);
  });
});

function makeDecision(
  overrides: Partial<SimilarDecision> = {},
): SimilarDecision {
  return {
    id: "dec_1",
    storeId: "store_1",
    auditLogId: null,
    planId: null,
    followupId: "f_1",
    conversationId: "conv_1",
    productId: "gid://shopify/Product/123",
    category: "conversion_rate",
    hypothesis:
      "rewriting the warranty paragraph should lift conversion because the previous copy buried the lifetime guarantee",
    expectedOutcome: "Expect a 5% lift in conversion_rate.",
    actualOutcome: null,
    lesson: null,
    embedding: [],
    embeddingPending: true,
    createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    similarity: 0.92,
    ...overrides,
  };
}

describe("formatDecisionForPrompt", () => {
  it("includes age, similarity %, category, and hypothesis", () => {
    const out = formatDecisionForPrompt(makeDecision());
    expect(out).toMatch(/30 days ago/);
    expect(out).toMatch(/92%/);
    expect(out).toMatch(/conversion_rate/);
    expect(out).toMatch(/warranty paragraph/);
  });

  it("renders 'today' for same-day decisions", () => {
    const out = formatDecisionForPrompt(
      makeDecision({ createdAt: new Date().toISOString() }),
    );
    expect(out).toMatch(/today/);
  });

  it("renders '1 day ago' (singular) correctly", () => {
    const out = formatDecisionForPrompt(
      makeDecision({
        createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      }),
    );
    expect(out).toMatch(/1 day ago/);
    expect(out).not.toMatch(/1 days ago/);
  });

  it("shows 'outcome pending evaluation' when actualOutcome is null", () => {
    const out = formatDecisionForPrompt(makeDecision());
    expect(out).toMatch(/outcome pending evaluation/i);
  });

  it("shows the actualOutcome verbatim once populated", () => {
    const out = formatDecisionForPrompt(
      makeDecision({
        actualOutcome:
          "improved: conversion lifted 4.2% (p=0.03)",
      }),
    );
    expect(out).toContain("improved: conversion lifted 4.2% (p=0.03)");
  });

  it("includes the lesson on its own line when present", () => {
    const out = formatDecisionForPrompt(
      makeDecision({
        lesson: "warranty-forward copy works for high-AOV pet products",
      }),
    );
    expect(out).toContain("Lesson: warranty-forward copy");
  });

  it("omits the lesson line entirely when null", () => {
    const out = formatDecisionForPrompt(makeDecision({ lesson: null }));
    expect(out).not.toMatch(/Lesson:/);
  });
});

describe("formatDecisionsAsMarkdown", () => {
  it("returns empty string when no decisions provided", () => {
    expect(formatDecisionsAsMarkdown([], 0)).toBe("");
    expect(formatDecisionsAsMarkdown([], 12)).toBe("");
  });

  it("includes a 'showing N of M' note when filtered", () => {
    const out = formatDecisionsAsMarkdown([makeDecision()], 12);
    expect(out).toMatch(/1 most relevant past decisions out of 12/);
  });

  it("uses simpler intro when showing all candidates", () => {
    const out = formatDecisionsAsMarkdown([makeDecision()], 1);
    expect(out).not.toMatch(/out of/);
    expect(out).toMatch(/past decisions semantically similar/);
  });

  it("includes each decision's formatted body", () => {
    const out = formatDecisionsAsMarkdown(
      [
        makeDecision({ id: "d1", hypothesis: "first decision body" }),
        makeDecision({ id: "d2", hypothesis: "second decision body" }),
      ],
      2,
    );
    expect(out).toContain("first decision body");
    expect(out).toContain("second decision body");
  });

  it("instructs the CEO to skip irrelevant retrievals", () => {
    // Critical guardrail — the LLM must not feel obligated to reference
    // a retrieved decision if it doesn't actually apply. The prompt
    // header carries this instruction.
    const out = formatDecisionsAsMarkdown([makeDecision()], 1);
    expect(out).toMatch(/skip|don't.+apply|naturally/i);
  });
});
