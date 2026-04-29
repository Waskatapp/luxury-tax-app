import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRACE_DAYS,
  EXPECTED_DIRECTION_VALUES,
  EvaluationCriteriaSchema,
  METRIC_VALUES,
  ProposeFollowupInputSchema,
  computeDueDates,
  followupSummary,
  isFollowupStatus,
  type FollowupRow,
} from "../../../app/lib/agent/followups.server";

describe("EvaluationCriteriaSchema", () => {
  it("accepts criteria with min_sessions + max_days only", () => {
    const r = EvaluationCriteriaSchema.safeParse({
      min_sessions: 200,
      max_days: 30,
    });
    expect(r.success).toBe(true);
  });

  it("accepts criteria with min_days + max_days only", () => {
    const r = EvaluationCriteriaSchema.safeParse({
      min_days: 14,
      max_days: 60,
    });
    expect(r.success).toBe(true);
  });

  it("accepts criteria with both min_sessions and min_days set", () => {
    const r = EvaluationCriteriaSchema.safeParse({
      min_sessions: 100,
      min_days: 7,
      max_days: 30,
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional min_units and min_orders", () => {
    const r = EvaluationCriteriaSchema.safeParse({
      min_orders: 30,
      max_days: 21,
    });
    // min_orders alone isn't enough — at least one of min_sessions or
    // min_days is required. But optional gating fields can ride along.
    expect(r.success).toBe(false);

    const r2 = EvaluationCriteriaSchema.safeParse({
      min_days: 7,
      min_orders: 30,
      min_units: 10,
      max_days: 21,
    });
    expect(r2.success).toBe(true);
  });

  it("rejects criteria with neither min_sessions nor min_days", () => {
    const r = EvaluationCriteriaSchema.safeParse({ max_days: 30 });
    expect(r.success).toBe(false);
  });

  it("rejects criteria where min_days > max_days", () => {
    const r = EvaluationCriteriaSchema.safeParse({
      min_days: 60,
      max_days: 30,
    });
    expect(r.success).toBe(false);
  });

  it("rejects max_days greater than 365", () => {
    const r = EvaluationCriteriaSchema.safeParse({
      min_days: 1,
      max_days: 400,
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative or zero values", () => {
    expect(
      EvaluationCriteriaSchema.safeParse({ min_days: 0, max_days: 10 }).success,
    ).toBe(false);
    expect(
      EvaluationCriteriaSchema.safeParse({ min_sessions: -1, max_days: 10 })
        .success,
    ).toBe(false);
  });

  it("rejects when max_days is missing", () => {
    const r = EvaluationCriteriaSchema.safeParse({ min_days: 7 });
    expect(r.success).toBe(false);
  });
});

describe("ProposeFollowupInputSchema", () => {
  const validBase = {
    metric: "conversion_rate" as const,
    hypothesis: "rewriting the warranty paragraph should lift conversion",
    expectedDirection: "lift" as const,
    baselineSnapshot: { sessions: 1200, conversions: 38, asOf: "2026-04-29" },
    evaluationCriteria: { min_sessions: 200, max_days: 30 },
  };

  it("accepts a minimal valid input", () => {
    const r = ProposeFollowupInputSchema.safeParse(validBase);
    expect(r.success).toBe(true);
  });

  it("accepts optional productId / expectedEffectPct / link ids", () => {
    const r = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      productId: "gid://shopify/Product/123",
      expectedEffectPct: 5.5,
      auditLogId: "audit_1",
      toolCallId: "tc_1",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown metric", () => {
    const r = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      metric: "click_through" as never,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown expectedDirection", () => {
    const r = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      expectedDirection: "skyrocket" as never,
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty hypothesis", () => {
    const r = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      hypothesis: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects oversize hypothesis (>500 chars)", () => {
    const r = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      hypothesis: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("accepts an arbitrary baselineSnapshot shape", () => {
    // The snapshot is intentionally untyped JSON — different metrics
    // store different fields. The schema is permissive on purpose.
    const r1 = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      metric: "revenue",
      baselineSnapshot: { revenue: 12500, currency: "USD", asOf: "2026-04-29" },
    });
    expect(r1.success).toBe(true);

    const r2 = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      metric: "units_sold",
      baselineSnapshot: { units: 42, asOf: "2026-04-29" },
    });
    expect(r2.success).toBe(true);
  });

  it("rejects bogus criteria via the criteria schema", () => {
    const r = ProposeFollowupInputSchema.safeParse({
      ...validBase,
      evaluationCriteria: { max_days: 30 }, // missing min_sessions/min_days
    });
    expect(r.success).toBe(false);
  });
});

describe("computeDueDates", () => {
  const createdAt = new Date("2026-04-29T12:00:00.000Z");

  it("uses min_days as the dueAt offset", () => {
    const r = computeDueDates({
      criteria: { min_days: 14, max_days: 60 },
      createdAt,
    });
    const expectedDue = new Date(createdAt.getTime() + 14 * 86400 * 1000);
    expect(r.dueAt.getTime()).toBe(expectedDue.getTime());
  });

  it("dueAt = createdAt when min_days is unset (gate is min_sessions)", () => {
    const r = computeDueDates({
      criteria: { min_sessions: 200, max_days: 30 },
      createdAt,
    });
    expect(r.dueAt.getTime()).toBe(createdAt.getTime());
  });

  it("abandonAt = createdAt + max_days + grace (default grace=7)", () => {
    const r = computeDueDates({
      criteria: { min_days: 14, max_days: 30 },
      createdAt,
    });
    const expectedAbandon = new Date(
      createdAt.getTime() + (30 + DEFAULT_GRACE_DAYS) * 86400 * 1000,
    );
    expect(r.abandonAt.getTime()).toBe(expectedAbandon.getTime());
  });

  it("respects a custom graceDays", () => {
    const r = computeDueDates({
      criteria: { min_days: 14, max_days: 30 },
      createdAt,
      graceDays: 0,
    });
    const expectedAbandon = new Date(createdAt.getTime() + 30 * 86400 * 1000);
    expect(r.abandonAt.getTime()).toBe(expectedAbandon.getTime());
  });

  it("dueAt is always before abandonAt for valid criteria", () => {
    const r = computeDueDates({
      criteria: { min_days: 60, max_days: 60 },
      createdAt,
    });
    expect(r.dueAt.getTime()).toBeLessThan(r.abandonAt.getTime());
  });
});

describe("followupSummary", () => {
  function makeRow(overrides: Partial<FollowupRow> = {}): FollowupRow {
    return {
      id: "fu_1",
      storeId: "store_1",
      conversationId: "conv_1",
      auditLogId: null,
      toolCallId: "tc_1",
      productId: "gid://shopify/Product/123",
      metric: "conversion_rate",
      hypothesis: "warranty paragraph should lift conversion",
      expectedDirection: "lift",
      expectedEffectPct: 5,
      baselineSnapshot: { sessions: 1200, conversions: 38 },
      evaluationCriteria: { min_sessions: 200, max_days: 30 },
      status: "PENDING",
      dueAt: "2026-04-29T12:00:00.000Z",
      abandonAt: "2026-06-05T12:00:00.000Z",
      evaluatedAt: null,
      insightId: null,
      createdAt: "2026-04-29T12:00:00.000Z",
      ...overrides,
    };
  }

  it("returns a token-cheap summary for the tool_result", () => {
    const s = followupSummary(makeRow());
    expect(s).toEqual({
      followupId: "fu_1",
      metric: "conversion_rate",
      hypothesis: "warranty paragraph should lift conversion",
      dueAt: "2026-04-29T12:00:00.000Z",
      abandonAt: "2026-06-05T12:00:00.000Z",
    });
  });

  it("does NOT include the baseline snapshot or full evaluation criteria", () => {
    // Both are JSON blobs that can grow. Keep them out of the tool_result
    // to avoid bloating Gemini's history.
    const s = followupSummary(makeRow());
    expect(s).not.toHaveProperty("baselineSnapshot");
    expect(s).not.toHaveProperty("evaluationCriteria");
  });
});

describe("isFollowupStatus", () => {
  it.each(["PENDING", "EVALUATED", "ABANDONED"])("accepts %s", (s) => {
    expect(isFollowupStatus(s)).toBe(true);
  });

  it("rejects unknown / lowercase / empty", () => {
    expect(isFollowupStatus("DRAFT")).toBe(false);
    expect(isFollowupStatus("pending")).toBe(false);
    expect(isFollowupStatus("")).toBe(false);
  });
});

describe("METRIC_VALUES + EXPECTED_DIRECTION_VALUES", () => {
  it("ships with the V3.1 metric vocabulary", () => {
    // Snapshot the initial vocabulary so a regression / accidental
    // rename gets caught in CI. Adding new metrics is fine — this test
    // gets updated when a new one ships.
    expect(METRIC_VALUES).toEqual([
      "conversion_rate",
      "revenue",
      "sessions",
      "units_sold",
      "aov",
      "inventory_at_risk",
    ]);
    expect(EXPECTED_DIRECTION_VALUES).toEqual(["lift", "drop", "neutral"]);
  });
});
