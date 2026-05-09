import { describe, expect, it } from "vitest";

import {
  detectAbandonmentByRouterReason,
  detectLatencyOutliers,
  detectOverModeledFastPaths,
  detectUnderModeledSlowPaths,
} from "../../../app/lib/eval/router-analyzer.server";

type Row = {
  outcome: string;
  toolCalls: number;
  hadWriteTool: boolean;
  latencyMs: number | null;
  modelUsed: string | null;
  routerReason: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    outcome: "informational",
    toolCalls: 0,
    hadWriteTool: false,
    latencyMs: 1500,
    modelUsed: "gemini-2.5-flash",
    routerReason: "default",
    ...overrides,
  };
}

describe("detectOverModeledFastPaths", () => {
  it("returns null below the minimum sample size", () => {
    const rows = Array.from({ length: 10 }, () =>
      row({ toolCalls: 0, latencyMs: 500 }),
    );
    expect(detectOverModeledFastPaths(rows, 7)).toBeNull();
  });

  it("flags when 25%+ of Flash turns are fast-path zero-tool informational", () => {
    // 30 Flash turns; 10 of them fast-path (33%)
    const fastPath = Array.from({ length: 10 }, () =>
      row({ toolCalls: 0, latencyMs: 800, outcome: "informational" }),
    );
    const others = Array.from({ length: 20 }, () =>
      row({ toolCalls: 2, latencyMs: 4000, outcome: "approved" }),
    );
    const finding = detectOverModeledFastPaths([...fastPath, ...others], 7);
    expect(finding).not.toBeNull();
    expect(finding?.component).toBe("router-over-modeled");
    expect(finding?.severity).toBe("info");
    expect(finding?.evidence.fastPathFlashTurns).toBe(10);
    expect(finding?.evidence.flashTurns).toBe(30);
  });

  it("does not flag when fast-path ratio is below 25%", () => {
    // 30 Flash turns; only 5 fast-path (~17%)
    const fastPath = Array.from({ length: 5 }, () =>
      row({ toolCalls: 0, latencyMs: 800, outcome: "informational" }),
    );
    const others = Array.from({ length: 25 }, () =>
      row({ toolCalls: 2, latencyMs: 4000, outcome: "approved" }),
    );
    expect(detectOverModeledFastPaths([...fastPath, ...others], 7)).toBeNull();
  });

  it("ignores Flash-Lite turns when computing the ratio", () => {
    // 30 Flash turns + 50 Flash-Lite turns; 10 Flash fast-path
    const flashFastPath = Array.from({ length: 10 }, () =>
      row({ toolCalls: 0, latencyMs: 800, outcome: "informational" }),
    );
    const flashOthers = Array.from({ length: 20 }, () =>
      row({ toolCalls: 2, latencyMs: 4000, outcome: "approved" }),
    );
    const liteRows = Array.from({ length: 50 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", toolCalls: 0 }),
    );
    const finding = detectOverModeledFastPaths(
      [...flashFastPath, ...flashOthers, ...liteRows],
      7,
    );
    expect(finding?.evidence.flashTurns).toBe(30);
  });

  it("excludes turns with hadWriteTool from fast-path bucket", () => {
    const fastPath = Array.from({ length: 10 }, () =>
      row({ toolCalls: 0, latencyMs: 800, outcome: "informational", hadWriteTool: true }),
    );
    const others = Array.from({ length: 20 }, () =>
      row({ toolCalls: 2, latencyMs: 4000 }),
    );
    expect(detectOverModeledFastPaths([...fastPath, ...others], 7)).toBeNull();
  });
});

describe("detectUnderModeledSlowPaths", () => {
  it("returns null below sample minimum", () => {
    const rows = Array.from({ length: 5 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "abandoned" }),
    );
    expect(detectUnderModeledSlowPaths(rows, 7)).toBeNull();
  });

  it("flags when 30%+ of Flash-Lite turns ended in clarified/abandoned", () => {
    const struggled = Array.from({ length: 6 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "abandoned" }),
    );
    const ok = Array.from({ length: 14 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "informational" }),
    );
    const finding = detectUnderModeledSlowPaths([...struggled, ...ok], 7);
    expect(finding).not.toBeNull();
    expect(finding?.component).toBe("router-under-modeled");
    expect(finding?.severity).toBe("warn");
    expect(finding?.evidence.struggledTurns).toBe(6);
  });

  it("does not flag below 30% struggle rate", () => {
    const struggled = Array.from({ length: 2 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "abandoned" }),
    );
    const ok = Array.from({ length: 18 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "informational" }),
    );
    expect(detectUnderModeledSlowPaths([...struggled, ...ok], 7)).toBeNull();
  });

  it("counts both clarified and abandoned as struggle", () => {
    const clarified = Array.from({ length: 4 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "clarified" }),
    );
    const abandoned = Array.from({ length: 4 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "abandoned" }),
    );
    const ok = Array.from({ length: 12 }, () =>
      row({ modelUsed: "gemini-2.5-flash-lite", outcome: "informational" }),
    );
    const finding = detectUnderModeledSlowPaths(
      [...clarified, ...abandoned, ...ok],
      7,
    );
    expect(finding?.evidence.struggledTurns).toBe(8);
  });
});

describe("detectAbandonmentByRouterReason", () => {
  it("flags the reason with highest abandonment rate when above threshold", () => {
    // first-word "show" — 6 of 8 abandoned (75%)
    const showAbandoned = Array.from({ length: 6 }, () =>
      row({
        routerReason: 'first-word "show" — read-only summary',
        outcome: "abandoned",
      }),
    );
    const showOk = Array.from({ length: 2 }, () =>
      row({
        routerReason: 'first-word "show" — read-only summary',
        outcome: "informational",
      }),
    );
    // default — 1 of 10 abandoned (10%)
    const defaultRows = Array.from({ length: 10 }, (_, i) =>
      row({
        routerReason: "default",
        outcome: i === 0 ? "abandoned" : "informational",
      }),
    );
    const finding = detectAbandonmentByRouterReason(
      [...showAbandoned, ...showOk, ...defaultRows],
      7,
    );
    expect(finding).not.toBeNull();
    expect(finding?.component).toBe("router-abandonment-by-reason");
    expect(finding?.evidence.routerReason).toContain("show");
    expect(finding?.evidence.rate).toBeCloseTo(0.75, 2);
  });

  it("does not flag below 50% abandonment threshold", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({
        routerReason: "default",
        outcome: i < 4 ? "abandoned" : "informational",
      }),
    );
    expect(detectAbandonmentByRouterReason(rows, 7)).toBeNull();
  });

  it("ignores router reasons below sample minimum", () => {
    const rows = Array.from({ length: 4 }, () =>
      row({ routerReason: "rare-reason", outcome: "abandoned" }),
    );
    expect(detectAbandonmentByRouterReason(rows, 7)).toBeNull();
  });

  it("returns null when no router reason exceeds threshold", () => {
    const rows = Array.from({ length: 20 }, () =>
      row({ routerReason: "default", outcome: "informational" }),
    );
    expect(detectAbandonmentByRouterReason(rows, 7)).toBeNull();
  });
});

describe("detectLatencyOutliers", () => {
  it("flags when p95+ slow turns dominantly share one router reason (≥60%)", () => {
    // 100 turns, p95 = ~9500ms. Make outliers (top 5) all share one
    // reason.
    const fast = Array.from({ length: 95 }, (_, i) =>
      row({ latencyMs: 1000 + i * 50, routerReason: "default" }),
    );
    const slowOutliers = Array.from({ length: 5 }, () =>
      row({ latencyMs: 30000, routerReason: "active plan — multi-step reasoning needed" }),
    );
    const finding = detectLatencyOutliers([...fast, ...slowOutliers], 7);
    expect(finding).not.toBeNull();
    expect(finding?.component).toBe("router-latency-outliers");
    expect(finding?.evidence.dominantReason).toContain("active plan");
    expect(finding?.evidence.dominantShare).toBeGreaterThanOrEqual(0.6);
  });

  it("returns null below sample minimum", () => {
    const rows = Array.from({ length: 10 }, () => row({ latencyMs: 1000 }));
    expect(detectLatencyOutliers(rows, 7)).toBeNull();
  });

  it("returns null when latency outliers spread across many reasons (no dominant cluster)", () => {
    const fast = Array.from({ length: 95 }, (_, i) =>
      row({ latencyMs: 1000 + i * 50, routerReason: `reason-${i % 5}` }),
    );
    const slow = Array.from({ length: 5 }, (_, i) =>
      row({ latencyMs: 30000, routerReason: `reason-${i}` }),
    );
    expect(detectLatencyOutliers([...fast, ...slow], 7)).toBeNull();
  });
});
