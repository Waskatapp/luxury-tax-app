import { z } from "zod";

import { GEMINI_MEMORY_MODEL, getGeminiClient } from "./gemini.server";
import { log } from "../log.server";
import {
  absoluteEffectSize,
  deriveConfidence,
  deriveVerdict,
  twoProportionZTest,
  type SignificanceResult,
  type Verdict,
} from "../stats/significance.server";
import {
  getProductWindowAnalytics,
  type ProductWindowResult,
} from "../shopify/analytics.server";
import type { ShopifyAdmin } from "../shopify/graphql-client.server";
import type {
  EvaluationCriteria,
  ExpectedDirection,
  FollowupMetric,
  FollowupRow,
} from "./followups.server";

// V3.2 — Phase 3 Autonomous Reasoning Loop. The offline post-mortem brain.
// Runs from .github/workflows/followup-evaluator.yml via scripts/run-evaluator.ts.
// Pure orchestration: significance math is in lib/stats/, analytics queries
// are in lib/shopify/, narrative is one Gemini Flash-Lite call.
//
// The math decides the verdict; the LLM only narrates. The post-mortem prompt
// is REQUIRED to be consistent with the computed verdict — never claim a win
// the math doesn't support. See `buildPostMortemPrompt` below.
//
// Three exit paths from `evaluateFollowup`:
//   - "evaluated": criteria met, verdict computed (improved/worsened/
//     inconclusive). Write the Insight, flip status to EVALUATED.
//   - "abandoned": now >= followup.abandonAt. Write an
//     `insufficient_data` Insight, flip status to ABANDONED.
//   - "not_yet_due": criteria not yet met (e.g. min_sessions short). The
//     cron leaves the row for the next day. The dueAt is already past;
//     the dynamic gate is the criteria, not the calendar.

export type EvaluationOutcome =
  | { kind: "evaluated"; insight: InsightPayload }
  | { kind: "abandoned"; insight: InsightPayload }
  | { kind: "not_yet_due"; reason: string };

export type InsightPayload = {
  category: "outcome_postmortem";
  title: string;
  body: string;
  verdict: Verdict;
  confidence: number;
  significanceP: number | null;
};

const NarrativeSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1500),
});

// Metrics we can compute today via the Admin API. sessions / conversion_rate
// require external analytics (Phase 3.4) and short-circuit to insufficient_data.
const SUPPORTED_METRICS: FollowupMetric[] = [
  "revenue",
  "units_sold",
  "aov",
];

export function isMetricSupported(metric: FollowupMetric): boolean {
  return (SUPPORTED_METRICS as string[]).includes(metric);
}

// Top-level entrypoint. Pure-ish — depends on `now`, `admin`, and the Gemini
// client. Returns the Insight payload to be persisted by the caller.
//
// The caller (scripts/run-evaluator.ts) handles the DB writes — this
// function only computes the result so it stays unit-testable.
export async function evaluateFollowup(opts: {
  admin: ShopifyAdmin;
  followup: FollowupRow;
  now: Date;
}): Promise<EvaluationOutcome> {
  const { admin, followup, now } = opts;
  const abandonAt = new Date(followup.abandonAt);
  const isPastAbandon = now.getTime() >= abandonAt.getTime();

  // Short-circuit: metric not supported by current evaluator. Flow as
  // insufficient_data once the followup hits its abandon time; before
  // that, leave it parked so a future Phase 3.4 GSC integration could
  // pick it up.
  if (!isMetricSupported(followup.metric)) {
    if (!isPastAbandon) {
      return {
        kind: "not_yet_due",
        reason: `metric '${followup.metric}' is not yet supported by the offline evaluator (Phase 3.4 will add external analytics)`,
      };
    }
    const insight = buildInsufficientDataInsight(
      followup,
      "metric not yet supported by the offline evaluator",
    );
    return { kind: "abandoned", insight };
  }

  // Pull the after-window. Window is the time from the followup's
  // creation to now; we compare against the baselineSnapshot which was
  // captured at creation time.
  const startsAt = new Date(followup.createdAt);
  const windowResult = await getProductWindowAnalytics(admin, {
    productId: followup.productId,
    startsAt,
    endsAt: now,
  });
  if (!windowResult.ok) {
    log.warn("evaluator: analytics fetch failed", {
      followupId: followup.id,
      err: windowResult.error,
    });
    if (!isPastAbandon) {
      return {
        kind: "not_yet_due",
        reason: `analytics fetch failed: ${windowResult.error}`,
      };
    }
    const insight = buildInsufficientDataInsight(
      followup,
      `analytics could not be retrieved before abandon: ${windowResult.error}`,
    );
    return { kind: "abandoned", insight };
  }

  const after = windowResult.data;
  const enoughData = checkEnoughData(followup.evaluationCriteria, after);

  if (!enoughData.met) {
    if (!isPastAbandon) {
      return { kind: "not_yet_due", reason: enoughData.reason };
    }
    const insight = buildInsufficientDataInsight(
      followup,
      `${enoughData.reason} — abandoning at max_days`,
    );
    return { kind: "abandoned", insight };
  }

  // Compute significance.
  const baselineMetric = extractBaselineMetric(followup);
  const afterMetric = extractAfterMetric(followup.metric, after);
  const significance = computeSignificance(
    followup.metric,
    baselineMetric,
    afterMetric,
  );
  const verdict = deriveVerdict({
    significance,
    expectedDirection: followup.expectedDirection,
    enoughData: true,
  });
  const confidence = deriveConfidence({
    verdict,
    significance,
    enoughData: true,
  });

  // Generate the narrative. Tolerant of failure — falls back to a
  // computed title + body if Gemini is unavailable.
  const narrative = await generateNarrative({
    followup,
    baseline: baselineMetric,
    after: afterMetric,
    significance,
    verdict,
  });

  return {
    kind: "evaluated",
    insight: {
      category: "outcome_postmortem",
      title: narrative.title,
      body: narrative.body,
      verdict,
      confidence,
      significanceP: significance.testName === "two_proportion_z" ? significance.pValue : null,
    },
  };
}

type BaselineMetric =
  | { kind: "absolute"; value: number }
  | { kind: "proportion"; successes: number; trials: number };

function extractBaselineMetric(followup: FollowupRow): BaselineMetric {
  const snap = followup.baselineSnapshot;
  switch (followup.metric) {
    case "revenue":
      return { kind: "absolute", value: parseAbs(snap.revenue) };
    case "units_sold":
      return { kind: "absolute", value: parseAbs(snap.units ?? snap.unitsSold) };
    case "aov": {
      const revenue = parseAbs(snap.revenue);
      const orders = parseAbs(snap.orderCount ?? snap.orders);
      return { kind: "absolute", value: orders === 0 ? 0 : revenue / orders };
    }
    case "sessions":
    case "conversion_rate":
    case "inventory_at_risk":
      // Punted to insufficient_data path; not reachable here because
      // isMetricSupported short-circuits before we get this far. Kept
      // for type exhaustion.
      return { kind: "absolute", value: 0 };
  }
}

function extractAfterMetric(
  metric: FollowupMetric,
  after: ProductWindowResult,
): BaselineMetric {
  switch (metric) {
    case "revenue":
      return { kind: "absolute", value: parseAbs(after.revenue) };
    case "units_sold":
      return { kind: "absolute", value: after.unitsSold };
    case "aov":
      return {
        kind: "absolute",
        value: after.orderCount === 0 ? 0 : parseAbs(after.revenue) / after.orderCount,
      };
    case "sessions":
    case "conversion_rate":
    case "inventory_at_risk":
      return { kind: "absolute", value: 0 };
  }
}

function parseAbs(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function computeSignificance(
  _metric: FollowupMetric,
  baseline: BaselineMetric,
  after: BaselineMetric,
): SignificanceResult {
  if (baseline.kind === "proportion" && after.kind === "proportion") {
    return twoProportionZTest(
      { successes: baseline.successes, trials: baseline.trials },
      { successes: after.successes, trials: after.trials },
    );
  }
  if (baseline.kind === "absolute" && after.kind === "absolute") {
    return absoluteEffectSize(baseline.value, after.value);
  }
  // Mixed (shouldn't happen with current metrics).
  return absoluteEffectSize(0, 0);
}

// Check whether the evaluation criteria have been met. Pure function over
// the criteria + after-window data.
export function checkEnoughData(
  criteria: EvaluationCriteria,
  after: ProductWindowResult,
): { met: boolean; reason: string } {
  // min_days is enforced upstream via dueAt — the cron only picks rows
  // where dueAt <= now, so by the time we're here, days have passed.
  // What we still need to check are sample-size criteria.
  if (
    criteria.min_orders !== undefined &&
    after.orderCount < criteria.min_orders
  ) {
    return {
      met: false,
      reason: `need ${criteria.min_orders} orders, have ${after.orderCount}`,
    };
  }
  if (
    criteria.min_units !== undefined &&
    after.unitsSold < criteria.min_units
  ) {
    return {
      met: false,
      reason: `need ${criteria.min_units} units sold, have ${after.unitsSold}`,
    };
  }
  // min_sessions: not measurable today (Admin API). If the criterion
  // includes it but no other gate is satisfied, fall through. We
  // accept the followup as "ready" if at least one OTHER threshold
  // (min_orders / min_units / min_days) is met. min_sessions becomes a
  // soft hint, not a hard gate, until Phase 3.4.
  return { met: true, reason: "criteria met" };
}

function buildInsufficientDataInsight(
  followup: FollowupRow,
  detail: string,
): InsightPayload {
  return {
    category: "outcome_postmortem",
    title: `Couldn't measure: ${followup.hypothesis}`,
    body: `Followup queued ${followup.createdAt.split("T")[0]} on metric \`${followup.metric}\`. Reason: ${detail}.`,
    verdict: "insufficient_data",
    confidence: 0.2,
    significanceP: null,
  };
}

// LLM-side narrative. Forced JSON, low temperature, generous fall-back.
async function generateNarrative(opts: {
  followup: FollowupRow;
  baseline: BaselineMetric;
  after: BaselineMetric;
  significance: SignificanceResult;
  verdict: Verdict;
}): Promise<{ title: string; body: string }> {
  try {
    const ai = getGeminiClient();
    const userMessage = buildPostMortemPrompt(opts);
    const response = await ai.models.generateContent({
      model: GEMINI_MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: NARRATIVE_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 600,
      },
    });
    const text = response.text?.trim() ?? "";
    if (!text) return fallbackNarrative(opts);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const stripped = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      try {
        parsed = JSON.parse(stripped);
      } catch {
        return fallbackNarrative(opts);
      }
    }
    const result = NarrativeSchema.safeParse(parsed);
    if (!result.success) return fallbackNarrative(opts);
    return { title: result.data.title, body: result.data.body };
  } catch (err) {
    log.warn("evaluator: narrative generation failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallbackNarrative(opts);
  }
}

const NARRATIVE_SYSTEM_PROMPT = `You write a short post-mortem narrative for a Shopify merchant about a change they made N days ago. The math has already decided the verdict — your job is to NARRATE, not RE-DECIDE.

The verdict will be one of:
- "improved": the metric moved in the merchant's expected direction with statistical/effect-size support.
- "worsened": the metric moved AGAINST the merchant's expected direction.
- "inconclusive": no clear signal one way or the other.
- "insufficient_data": not enough data to tell.

Write a 2–3 sentence narrative that's HONEST about the verdict. NEVER claim a win when the verdict is "inconclusive" or "worsened." If "inconclusive", say so plainly — "the data is too noisy to call." If "worsened", own it — "this didn't work the way we hoped."

Use plain numbers. Cite the change in real units ("revenue went from $1,200 to $1,150 over the period"). Avoid jargon (no "p-value", no "effect size") — write for a non-technical store owner.

The merchant cares about ONE question: "should I do this again?" Your narrative answers that, briefly, in the body.

Output JSON ONLY: { "title": "...", "body": "..." }
- title: 1 sentence, ≤120 chars. Lead with the verdict ("Cat Food description rewrite — no clear lift.")
- body: 2–4 sentences explaining the data and what it suggests for next time.

No code fences. No prose preamble.`;

function buildPostMortemPrompt(opts: {
  followup: FollowupRow;
  baseline: BaselineMetric;
  after: BaselineMetric;
  significance: SignificanceResult;
  verdict: Verdict;
}): string {
  const { followup, baseline, after, significance, verdict } = opts;
  const baselineStr = formatMetricValue(baseline);
  const afterStr = formatMetricValue(after);
  const effectStr = significance.effectSizePct === null
    ? "(no baseline to compare against)"
    : `${significance.effectSizePct.toFixed(1)}%`;
  return [
    `Hypothesis: ${followup.hypothesis}`,
    `Expected direction: ${followup.expectedDirection}`,
    `Metric: ${followup.metric}`,
    `Product: ${followup.productId ?? "(store-wide)"}`,
    `Baseline (at write time): ${baselineStr}`,
    `After window: ${afterStr}`,
    `Effect size: ${effectStr}`,
    `Computed verdict: ${verdict}`,
    `Days elapsed: ${daysBetween(followup.createdAt, new Date().toISOString())}`,
  ].join("\n");
}

function formatMetricValue(m: BaselineMetric): string {
  if (m.kind === "absolute") return m.value.toFixed(2);
  return `${m.successes}/${m.trials} (${((m.successes / Math.max(1, m.trials)) * 100).toFixed(2)}%)`;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.max(0, Math.round((b - a) / (24 * 3600 * 1000)));
}

// Deterministic fallback when Gemini is unavailable. Still safe — the math
// drives the verdict, the words just describe it.
function fallbackNarrative(opts: {
  followup: FollowupRow;
  baseline: BaselineMetric;
  after: BaselineMetric;
  verdict: Verdict;
  significance: SignificanceResult;
}): { title: string; body: string } {
  const { followup, baseline, after, verdict, significance } = opts;
  const baselineStr = formatMetricValue(baseline);
  const afterStr = formatMetricValue(after);
  const effectStr = significance.effectSizePct === null
    ? "no baseline"
    : `${significance.effectSizePct >= 0 ? "+" : ""}${significance.effectSizePct.toFixed(1)}%`;
  const verdictHeadline =
    verdict === "improved"
      ? "moved in the right direction"
      : verdict === "worsened"
        ? "moved against expectations"
        : verdict === "inconclusive"
          ? "no clear signal"
          : "couldn't measure";
  const productLabel = followup.productId ? "product" : "store-wide";
  return {
    title: `${followup.metric} ${productLabel} — ${verdictHeadline}`,
    body: `Followup on "${followup.hypothesis}". ${followup.metric} went from ${baselineStr} to ${afterStr} (${effectStr}). Verdict: ${verdict}.`,
  };
}
