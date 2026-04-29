import { describe, expect, it } from "vitest";

import {
  absoluteEffectSize,
  deriveConfidence,
  deriveVerdict,
  twoProportionZTest,
  type SignificanceResult,
} from "../../../app/lib/stats/significance.server";

describe("twoProportionZTest", () => {
  it("returns a small p-value for clearly different proportions", () => {
    // 5/100 vs 30/100 — z ≈ 4.65 → p ≈ 0.000003 in theory, but
    // simple-statistics' normal-CDF approximation saturates earlier;
    // we accept p < 0.01 as "clearly significant."
    const r = twoProportionZTest(
      { successes: 5, trials: 100 },
      { successes: 30, trials: 100 },
    );
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.effectSize).toBeCloseTo(0.25, 5);
    expect(r.effectSizePct).toBeCloseTo(500, 0); // 0.05 → 0.30 = +500%
    expect(r.testName).toBe("two_proportion_z");
    expect(r.testStatistic).toBeGreaterThan(0); // p2 > p1
  });

  it("returns a high p-value for nearly identical proportions", () => {
    // 50/1000 vs 51/1000 — tiny difference, should not be significant.
    const r = twoProportionZTest(
      { successes: 50, trials: 1000 },
      { successes: 51, trials: 1000 },
    );
    expect(r.pValue).toBeGreaterThan(0.5);
  });

  it("flags a drop with a negative test statistic + effect", () => {
    const r = twoProportionZTest(
      { successes: 30, trials: 100 },
      { successes: 5, trials: 100 },
    );
    expect(r.testStatistic).toBeLessThan(0);
    expect(r.effectSize).toBeLessThan(0);
    expect(r.pValue).toBeLessThan(0.01);
  });

  it("handles n=0 on either side gracefully", () => {
    const r1 = twoProportionZTest(
      { successes: 0, trials: 0 },
      { successes: 5, trials: 100 },
    );
    expect(r1.pValue).toBe(1);
    expect(r1.effectSize).toBe(0);

    const r2 = twoProportionZTest(
      { successes: 5, trials: 100 },
      { successes: 0, trials: 0 },
    );
    expect(r2.pValue).toBe(1);
  });

  it("handles all-zero successes (se=0) without dividing by zero", () => {
    const r = twoProportionZTest(
      { successes: 0, trials: 100 },
      { successes: 0, trials: 100 },
    );
    expect(r.pValue).toBe(1);
    expect(r.effectSize).toBe(0);
    expect(r.effectSizePct).toBeNull();
    expect(Number.isFinite(r.testStatistic)).toBe(true);
  });

  it("returns null effectSizePct when before-rate is 0", () => {
    const r = twoProportionZTest(
      { successes: 0, trials: 100 },
      { successes: 5, trials: 100 },
    );
    expect(r.effectSizePct).toBeNull();
  });
});

describe("absoluteEffectSize", () => {
  it("returns signed effect + percentage change", () => {
    const r = absoluteEffectSize(100, 130);
    expect(r.effectSize).toBe(30);
    expect(r.effectSizePct).toBe(30);
    expect(r.pValue).toBe(1); // no real test
    expect(r.testName).toBe("absolute");
  });

  it("returns negative values for drops", () => {
    const r = absoluteEffectSize(200, 150);
    expect(r.effectSize).toBe(-50);
    expect(r.effectSizePct).toBe(-25);
  });

  it("returns null effectSizePct when before is 0", () => {
    const r = absoluteEffectSize(0, 50);
    expect(r.effectSizePct).toBeNull();
    expect(r.effectSize).toBe(50);
  });

  it("returns 0 effect when before === after", () => {
    const r = absoluteEffectSize(42, 42);
    expect(r.effectSize).toBe(0);
    expect(r.effectSizePct).toBe(0);
  });
});

describe("deriveVerdict", () => {
  function sig(over: Partial<SignificanceResult> = {}): SignificanceResult {
    return {
      testStatistic: 0,
      pValue: 1,
      effectSize: 0,
      effectSizePct: null,
      testName: "absolute",
      ...over,
    };
  }

  it("returns insufficient_data when enoughData is false", () => {
    const v = deriveVerdict({
      significance: sig({ pValue: 0.001, effectSize: 0.1 }),
      expectedDirection: "lift",
      enoughData: false,
    });
    expect(v).toBe("insufficient_data");
  });

  it("returns improved on significant lift in expected direction (proportion)", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 0.01,
        effectSize: 0.05,
        testName: "two_proportion_z",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("improved");
  });

  it("returns worsened on significant drop when CEO expected lift", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 0.01,
        effectSize: -0.05,
        testName: "two_proportion_z",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("worsened");
  });

  it("returns improved on a significant drop when CEO expected drop", () => {
    // E.g. inventory_at_risk metric: lower is better.
    const v = deriveVerdict({
      significance: sig({
        pValue: 0.01,
        effectSize: -0.05,
        testName: "two_proportion_z",
      }),
      expectedDirection: "drop",
      enoughData: true,
    });
    expect(v).toBe("improved");
  });

  it("returns inconclusive when proportion p-value is high (>=0.1)", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 0.3,
        effectSize: 0.02,
        testName: "two_proportion_z",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("inconclusive");
  });

  it("returns inconclusive for absolute effect under threshold", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 1,
        effectSize: 100,
        effectSizePct: 3, // < 5 default
        testName: "absolute",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("inconclusive");
  });

  it("returns improved for absolute effect over threshold in expected direction", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 1,
        effectSize: 100,
        effectSizePct: 12,
        testName: "absolute",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("improved");
  });

  it("returns worsened for absolute drop when expected direction is lift", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 1,
        effectSize: -50,
        effectSizePct: -15,
        testName: "absolute",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("worsened");
  });

  it("respects custom pValueThreshold and effectThresholdPct", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 0.07,
        effectSize: 0.03,
        testName: "two_proportion_z",
      }),
      expectedDirection: "lift",
      enoughData: true,
      pValueThreshold: 0.05, // strict
    });
    expect(v).toBe("inconclusive"); // 0.07 fails the strict 0.05

    const v2 = deriveVerdict({
      significance: sig({
        pValue: 1,
        effectSize: 50,
        effectSizePct: 8,
        testName: "absolute",
      }),
      expectedDirection: "lift",
      enoughData: true,
      effectThresholdPct: 10, // strict
    });
    expect(v2).toBe("inconclusive");
  });

  it("flags neutral-direction movement as worsened when effect is significant", () => {
    // CEO didn't expect a change but we got one — bet failed.
    const v = deriveVerdict({
      significance: sig({
        pValue: 0.001,
        effectSize: 0.05,
        testName: "two_proportion_z",
      }),
      expectedDirection: "neutral",
      enoughData: true,
    });
    expect(v).toBe("worsened");
  });

  it("flags neutral effect of zero as inconclusive", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 1,
        effectSize: 0,
        effectSizePct: 0,
        testName: "absolute",
      }),
      expectedDirection: "neutral",
      enoughData: true,
    });
    expect(v).toBe("inconclusive");
  });

  it("returns inconclusive when effectSizePct is null (zero baseline)", () => {
    const v = deriveVerdict({
      significance: sig({
        pValue: 1,
        effectSize: 50,
        effectSizePct: null,
        testName: "absolute",
      }),
      expectedDirection: "lift",
      enoughData: true,
    });
    expect(v).toBe("inconclusive");
  });
});

describe("deriveConfidence", () => {
  function sig(over: Partial<SignificanceResult> = {}): SignificanceResult {
    return {
      testStatistic: 0,
      pValue: 1,
      effectSize: 0,
      effectSizePct: null,
      testName: "absolute",
      ...over,
    };
  }

  it("returns 0.2 for insufficient_data", () => {
    expect(
      deriveConfidence({
        verdict: "insufficient_data",
        significance: sig(),
        enoughData: false,
      }),
    ).toBe(0.2);
  });

  it("returns 0.4 for inconclusive", () => {
    expect(
      deriveConfidence({
        verdict: "inconclusive",
        significance: sig(),
        enoughData: true,
      }),
    ).toBe(0.4);
  });

  it("scales with p-value for proportion tests (lower p = higher confidence)", () => {
    const c1 = deriveConfidence({
      verdict: "improved",
      significance: sig({ pValue: 0.0005, testName: "two_proportion_z" }),
      enoughData: true,
    });
    const c2 = deriveConfidence({
      verdict: "improved",
      significance: sig({ pValue: 0.04, testName: "two_proportion_z" }),
      enoughData: true,
    });
    expect(c1).toBeGreaterThan(c2);
    expect(c1).toBe(0.95);
    expect(c2).toBe(0.8); // p < 0.05 bucket
  });

  it("caps absolute confidence at 0.75 (no real p-value)", () => {
    const c = deriveConfidence({
      verdict: "improved",
      significance: sig({
        effectSizePct: 80,
        testName: "absolute",
      }),
      enoughData: true,
    });
    expect(c).toBe(0.75);
  });

  it("scales absolute confidence by effect magnitude", () => {
    const small = deriveConfidence({
      verdict: "improved",
      significance: sig({ effectSizePct: 7, testName: "absolute" }),
      enoughData: true,
    });
    const big = deriveConfidence({
      verdict: "improved",
      significance: sig({ effectSizePct: 30, testName: "absolute" }),
      enoughData: true,
    });
    expect(big).toBeGreaterThan(small);
  });
});
