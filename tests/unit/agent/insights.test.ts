import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAILY_INSIGHT_LIMIT,
  DEFAULT_PER_TURN_INSIGHT_LIMIT,
  formatInsightsAsMarkdown,
  type InsightRow,
} from "../../../app/lib/agent/insights.server";

function makeInsight(over: Partial<InsightRow> = {}): InsightRow {
  return {
    id: "ins_1",
    storeId: "store_1",
    followupId: "fu_1",
    category: "outcome_postmortem",
    title: "Cat Food description rewrite — no clear lift",
    body: "Conversion went from 2.1% to 2.3% over 4 weeks; not significant given sample size.",
    verdict: "inconclusive",
    confidence: 0.4,
    significanceP: 0.3,
    surfacedAt: null,
    dismissedAt: null,
    createdAt: "2026-04-29T00:00:00.000Z",
    ...over,
  };
}

describe("formatInsightsAsMarkdown", () => {
  it("returns empty string for empty input", () => {
    expect(formatInsightsAsMarkdown([])).toBe("");
  });

  it("includes the title and body for each insight", () => {
    const md = formatInsightsAsMarkdown([
      makeInsight({ title: "T1", body: "B1" }),
    ]);
    expect(md).toContain("T1");
    expect(md).toContain("B1");
  });

  it("tags improved insights with the success marker", () => {
    const md = formatInsightsAsMarkdown([
      makeInsight({ verdict: "improved", confidence: 0.85 }),
    ]);
    expect(md).toContain("improved");
    expect(md).toContain("0.85");
  });

  it("tags worsened insights with the failure marker", () => {
    const md = formatInsightsAsMarkdown([
      makeInsight({ verdict: "worsened", confidence: 0.7 }),
    ]);
    expect(md).toContain("worsened");
  });

  it("includes a guidance preamble (CEO must weave naturally)", () => {
    const md = formatInsightsAsMarkdown([makeInsight()]);
    // The preamble exists so the CEO doesn't dump the body verbatim — it
    // tells it to weave naturally and bring up at most one per response.
    expect(md.toLowerCase()).toContain("naturally");
    expect(md.toLowerCase()).toContain("at most one");
  });

  it("renders multiple insights separated visually", () => {
    const md = formatInsightsAsMarkdown([
      makeInsight({ id: "a", title: "A", verdict: "improved" }),
      makeInsight({ id: "b", title: "B", verdict: "worsened" }),
    ]);
    expect(md).toContain("A");
    expect(md).toContain("B");
    // Both verdict markers present.
    expect(md).toContain("improved");
    expect(md).toContain("worsened");
  });
});

describe("rate limit defaults", () => {
  it("ships with conservative caps (≤2 per turn, ≤2 per day)", () => {
    expect(DEFAULT_PER_TURN_INSIGHT_LIMIT).toBeLessThanOrEqual(2);
    expect(DEFAULT_DAILY_INSIGHT_LIMIT).toBeLessThanOrEqual(2);
    // Both >= 1 so the system is functional.
    expect(DEFAULT_PER_TURN_INSIGHT_LIMIT).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_DAILY_INSIGHT_LIMIT).toBeGreaterThanOrEqual(1);
  });
});
