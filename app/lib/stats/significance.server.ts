import { cumulativeStdNormalProbability } from "simple-statistics";

// V3.2 — Phase 3 Autonomous Reasoning Loop. Pure significance / effect-size
// math used by the offline evaluator. Critical: this is the difference
// between "the CEO claims wins on noise" and "the CEO is honest about
// uncertainty." All computations are IN CODE — never delegated to the LLM.
//
// Two test families:
//
// 1. Two-proportion z-test (`twoProportionZTest`) — for conversion-rate-shaped
//    metrics where we have successes-out-of-trials on both sides
//    (conversions/sessions, orders/sessions). Returns a real two-tailed p-value.
//
// 2. Absolute effect (`absoluteEffectSize`) — for revenue / units_sold / AOV
//    where we don't have per-order variance, only summary totals. We can
//    compute the percentage change but not a real p-value. The verdict layer
//    combines this with a sample-size threshold to decide "inconclusive vs
//    improved/worsened" — see deriveVerdict() below.
//
// We deliberately avoid Welch's t-test here. It needs per-sample data we
// don't collect today (revenue is summed, not stored per-order). Adding a
// per-sample query would 5x the analytics cost for marginal evaluator
// quality. Revisit if false-positive rate on absolute metrics is too high.

export type SignificanceTestName = "two_proportion_z" | "absolute";

export type SignificanceResult = {
  testStatistic: number; // z (proportion) or 0 (absolute)
  pValue: number; // two-tailed; 1.0 for absolute (no real test)
  effectSize: number; // signed: after - before (raw units)
  effectSizePct: number | null; // signed: (after - before) / before * 100; null if before is 0
  testName: SignificanceTestName;
};

export type ProportionInput = {
  successes: number;
  trials: number;
};

// Two-proportion z-test. Pools the proportions for the standard error
// estimate (the standard textbook formulation). Returns a two-tailed p-value.
//
// Edge cases:
//   - n1 === 0 || n2 === 0 → no test possible; returns p=1, effect=0.
//   - se === 0 (e.g. p1 === 0 && p2 === 0) → no variance; returns p=1
//     with the raw effect preserved for the verdict layer to decide.
export function twoProportionZTest(
  before: ProportionInput,
  after: ProportionInput,
): SignificanceResult {
  const { successes: x1, trials: n1 } = before;
  const { successes: x2, trials: n2 } = after;
  if (n1 === 0 || n2 === 0) {
    return {
      testStatistic: 0,
      pValue: 1,
      effectSize: 0,
      effectSizePct: null,
      testName: "two_proportion_z",
    };
  }
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  const effectSize = p2 - p1;
  const effectSizePct = p1 === 0 ? null : (effectSize / p1) * 100;
  if (se === 0) {
    return {
      testStatistic: 0,
      pValue: 1,
      effectSize,
      effectSizePct,
      testName: "two_proportion_z",
    };
  }
  const z = effectSize / se;
  // Two-tailed p = 2 * (1 - Φ(|z|)).
  const pValue = 2 * (1 - cumulativeStdNormalProbability(Math.abs(z)));
  return {
    testStatistic: z,
    pValue,
    effectSize,
    effectSizePct,
    testName: "two_proportion_z",
  };
}

// Absolute effect-size: use when we have summary totals only (revenue,
// units_sold, AOV). No real significance test — pValue is reported as 1.
// The verdict layer must use sample-size heuristics on top of this
// (e.g. "≥30% change AND ≥30 orders" → improved/worsened).
export function absoluteEffectSize(
  before: number,
  after: number,
): SignificanceResult {
  const effectSize = after - before;
  const effectSizePct = before === 0 ? null : (effectSize / before) * 100;
  return {
    testStatistic: 0,
    pValue: 1,
    effectSize,
    effectSizePct,
    testName: "absolute",
  };
}

// Verdict layer — combines significance + expected direction + sample
// adequacy into the four-bucket taxonomy used by Insight.verdict.
//
// Rules:
//   - Not enough data (caller decides via `enoughData=false`) → insufficient_data
//   - effect_size === 0 → inconclusive (truly nothing moved)
//   - For two-proportion: p < 0.1 AND in expected direction → improved
//                         p < 0.1 AND opposite direction → worsened
//                         p >= 0.1 → inconclusive
//   - For absolute (no real p): |effect_size_pct| >= effectThresholdPct
//     AND in expected direction → improved
//                                AND opposite direction → worsened
//     Otherwise → inconclusive
//
// Default to inconclusive — the prompt agent must NEVER claim a win unless
// the math says so. effect_size_pct is null when before is 0; in that case
// we fall back to inconclusive (no baseline to compare against).
export type Verdict =
  | "improved"
  | "worsened"
  | "inconclusive"
  | "insufficient_data";

export type ExpectedDirection = "lift" | "drop" | "neutral";

export type DeriveVerdictOpts = {
  significance: SignificanceResult;
  expectedDirection: ExpectedDirection;
  enoughData: boolean;
  pValueThreshold?: number; // default 0.1
  effectThresholdPct?: number; // default 5 (used by absolute)
};

export function deriveVerdict(opts: DeriveVerdictOpts): Verdict {
  if (!opts.enoughData) return "insufficient_data";

  const pThresh = opts.pValueThreshold ?? 0.1;
  const pctThresh = opts.effectThresholdPct ?? 5;
  const { effectSize, pValue, effectSizePct, testName } = opts.significance;
  const direction = opts.expectedDirection;

  // Neutral hypothesis: any movement of meaningful size means the bet
  // failed (the merchant expected it to NOT move). Map any directional
  // movement to "worsened" for neutral, since it contradicts the
  // hypothesis. Tiny movements stay inconclusive.
  if (direction === "neutral") {
    if (testName === "two_proportion_z") {
      if (pValue >= pThresh) return "inconclusive";
      return effectSize === 0 ? "inconclusive" : "worsened";
    }
    if (effectSizePct === null) return "inconclusive";
    if (Math.abs(effectSizePct) < pctThresh) return "inconclusive";
    return "worsened";
  }

  if (testName === "two_proportion_z") {
    if (pValue >= pThresh) return "inconclusive";
    if (effectSize === 0) return "inconclusive";
    return matchesExpected(effectSize, direction) ? "improved" : "worsened";
  }

  // absolute
  if (effectSizePct === null) return "inconclusive";
  if (Math.abs(effectSizePct) < pctThresh) return "inconclusive";
  return matchesExpected(effectSizePct, direction) ? "improved" : "worsened";
}

function matchesExpected(
  signedEffect: number,
  direction: Exclude<ExpectedDirection, "neutral">,
): boolean {
  if (direction === "lift") return signedEffect > 0;
  return signedEffect < 0;
}

// Confidence score for the Insight row. Combines p-value (where available)
// and sample adequacy into a 0–1 number. The CEO surfaces high-confidence
// Insights more aggressively (Phase 3.3 ranks by confidence DESC).
export function deriveConfidence(opts: {
  verdict: Verdict;
  significance: SignificanceResult;
  enoughData: boolean;
}): number {
  if (!opts.enoughData) return 0.2;
  if (opts.verdict === "insufficient_data") return 0.2;
  if (opts.verdict === "inconclusive") return 0.4;

  const { pValue, testName, effectSizePct } = opts.significance;
  if (testName === "two_proportion_z") {
    // Map p-value to confidence: p=0 → 0.95, p=0.1 → 0.6, p=0.5 → 0.4.
    if (pValue < 0.001) return 0.95;
    if (pValue < 0.01) return 0.9;
    if (pValue < 0.05) return 0.8;
    if (pValue < 0.1) return 0.7;
    return 0.5;
  }
  // Absolute: lean on effect magnitude as a proxy. Heuristic;
  // intentionally caps at 0.75 to flag that we don't have a real p.
  if (effectSizePct === null) return 0.4;
  const absPct = Math.abs(effectSizePct);
  if (absPct >= 50) return 0.75;
  if (absPct >= 25) return 0.65;
  if (absPct >= 10) return 0.55;
  return 0.45;
}
