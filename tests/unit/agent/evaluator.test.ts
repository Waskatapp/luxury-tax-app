import { describe, expect, it } from "vitest";

import {
  checkEnoughData,
  isMetricSupported,
} from "../../../app/lib/agent/evaluator.server";

const fakeWindow = (
  over: Partial<{
    productId: string | null;
    unitsSold: number;
    orderCount: number;
    revenue: string;
    currencyCode: string;
    cappedAtPageLimit: boolean;
    startsAt: string;
    endsAt: string;
  }> = {},
) => ({
  productId: null,
  startsAt: "2026-04-01T00:00:00.000Z",
  endsAt: "2026-04-29T00:00:00.000Z",
  unitsSold: 0,
  orderCount: 0,
  revenue: "0.00",
  currencyCode: "USD",
  cappedAtPageLimit: false,
  ...over,
});

describe("isMetricSupported", () => {
  it("supports revenue / units_sold / aov today", () => {
    expect(isMetricSupported("revenue")).toBe(true);
    expect(isMetricSupported("units_sold")).toBe(true);
    expect(isMetricSupported("aov")).toBe(true);
  });

  it("does NOT support sessions / conversion_rate (deferred to Phase 3.4)", () => {
    expect(isMetricSupported("sessions")).toBe(false);
    expect(isMetricSupported("conversion_rate")).toBe(false);
  });

  it("does NOT support inventory_at_risk (point-in-time, no window)", () => {
    expect(isMetricSupported("inventory_at_risk")).toBe(false);
  });
});

describe("checkEnoughData", () => {
  it("returns met=true when no sample-size criteria are set (only min_days)", () => {
    // min_days is enforced upstream via dueAt — the cron only picks rows
    // where dueAt <= now, so when we get here we've already cleared time.
    const r = checkEnoughData(
      { min_days: 14, max_days: 60 },
      fakeWindow({ orderCount: 0, unitsSold: 0 }),
    );
    expect(r.met).toBe(true);
  });

  it("blocks when min_orders is unmet", () => {
    const r = checkEnoughData(
      { min_days: 7, max_days: 30, min_orders: 30 },
      fakeWindow({ orderCount: 12 }),
    );
    expect(r.met).toBe(false);
    expect(r.reason).toContain("30 orders");
    expect(r.reason).toContain("12");
  });

  it("blocks when min_units is unmet", () => {
    const r = checkEnoughData(
      { min_days: 7, max_days: 30, min_units: 50 },
      fakeWindow({ unitsSold: 10 }),
    );
    expect(r.met).toBe(false);
    expect(r.reason).toContain("50 units sold");
    expect(r.reason).toContain("10");
  });

  it("passes when both min_orders and min_units are met", () => {
    const r = checkEnoughData(
      { min_days: 7, max_days: 30, min_orders: 10, min_units: 20 },
      fakeWindow({ orderCount: 25, unitsSold: 50 }),
    );
    expect(r.met).toBe(true);
  });

  it("ignores min_sessions until Phase 3.4 (soft hint, not a hard gate)", () => {
    // min_sessions can't be measured today — the criterion exists in the
    // followup but the gate falls through. The reason is "criteria met"
    // even though sessions is set; this lets evaluations proceed on
    // min_orders / min_units / min_days rather than sitting forever.
    const r = checkEnoughData(
      { min_sessions: 200, min_days: 7, max_days: 30 },
      fakeWindow({ orderCount: 5 }),
    );
    expect(r.met).toBe(true);
    expect(r.reason).toBe("criteria met");
  });

  it("blocks on min_orders even if min_sessions is the headline gate", () => {
    // If the CEO sets BOTH min_sessions (soft) and min_orders (hard),
    // min_orders must still be met.
    const r = checkEnoughData(
      { min_sessions: 200, min_orders: 10, min_days: 7, max_days: 30 },
      fakeWindow({ orderCount: 3 }),
    );
    expect(r.met).toBe(false);
    expect(r.reason).toContain("10 orders");
  });
});
