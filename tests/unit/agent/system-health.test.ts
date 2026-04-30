import { describe, expect, it } from "vitest";

import {
  buildEmbeddingStuckFinding,
  buildLatencyFinding,
  buildMissingTitleFinding,
  buildRejectionUserMessage,
  buildStaleAnomalyFinding,
  buildToolFailureFinding,
  buildToolRejectionFinding,
  classifyLatency,
  EMBEDDING_STUCK_MIN_COUNT,
  LATENCY_MIN_SAMPLE,
  MISSING_TITLE_MIN_COUNT,
  parseRejectionResponse,
  pickWorstRejectionPattern,
  pickWorstToolFailure,
  REJECTION_MIN_COUNT,
  STALE_ANOMALY_MIN_COUNT,
  TOOL_FAILURE_CRITICAL_AT,
  TOOL_FAILURE_FLOOR,
  type LatencyCandidate,
  type RejectionCandidate,
  type ToolFailureCandidate,
} from "../../../app/lib/agent/system-health.server";

describe("buildEmbeddingStuckFinding", () => {
  const baseOldest = {
    oldestId: "dec_abc123",
    oldestCreatedAt: new Date("2026-04-28T10:00:00Z"),
  };

  it("returns null when stuckCount is below threshold", () => {
    const out = buildEmbeddingStuckFinding({
      stuckCount: EMBEDDING_STUCK_MIN_COUNT - 1,
      ...baseOldest,
    });
    expect(out).toBeNull();
  });

  it("returns null when stuckCount is zero (no false positives on healthy stores)", () => {
    const out = buildEmbeddingStuckFinding({
      stuckCount: 0,
      ...baseOldest,
    });
    expect(out).toBeNull();
  });

  it("fires when stuckCount equals threshold (boundary)", () => {
    const out = buildEmbeddingStuckFinding({
      stuckCount: EMBEDDING_STUCK_MIN_COUNT,
      ...baseOldest,
    });
    expect(out).not.toBeNull();
    expect(out!.component).toBe("embedding_pipeline");
    expect(out!.severity).toBe("warn");
    expect(out!.scanName).toBe("embeddingStuckScan");
  });

  it("includes the stuck count in the message text", () => {
    const out = buildEmbeddingStuckFinding({
      stuckCount: 12,
      ...baseOldest,
    });
    expect(out!.message).toContain("12");
  });

  it("recommendation cites the precedent (text-embedding-004 deprecation)", () => {
    // Knowing the why behind the most likely cause is the load-bearing
    // operator-facing detail on this finding.
    const out = buildEmbeddingStuckFinding({
      stuckCount: 8,
      ...baseOldest,
    });
    expect(out!.recommendation).toContain("text-embedding-004");
  });

  it("evidence carries oldestId, ISO oldestCreatedAt, and threshold metadata", () => {
    const out = buildEmbeddingStuckFinding({
      stuckCount: 7,
      oldestId: "dec_xyz",
      oldestCreatedAt: new Date("2026-04-27T03:30:00Z"),
    });
    expect(out!.evidence).toEqual({
      stuckCount: 7,
      oldestId: "dec_xyz",
      oldestCreatedAt: "2026-04-27T03:30:00.000Z",
      thresholdHours: 24,
      thresholdMinCount: EMBEDDING_STUCK_MIN_COUNT,
    });
  });
});

describe("buildMissingTitleFinding", () => {
  it("returns null when count is below threshold", () => {
    const out = buildMissingTitleFinding({
      count: MISSING_TITLE_MIN_COUNT - 1,
      sampleConversationIds: ["conv_1", "conv_2"],
    });
    expect(out).toBeNull();
  });

  it("fires at threshold boundary", () => {
    const out = buildMissingTitleFinding({
      count: MISSING_TITLE_MIN_COUNT,
      sampleConversationIds: ["conv_1", "conv_2", "conv_3"],
    });
    expect(out).not.toBeNull();
    expect(out!.component).toBe("title_generator");
    expect(out!.severity).toBe("warn");
    expect(out!.scanName).toBe("missingConversationTitleScan");
  });

  it("recommendation cites the gating regression precedent", () => {
    // The most-recent real bug in this class was post-stream title-gen
    // gated behind text-buffer-length. The recommendation has to point
    // the operator at that pattern.
    const out = buildMissingTitleFinding({
      count: 5,
      sampleConversationIds: ["c1"],
    });
    expect(out!.recommendation).toContain("title-generator.server.ts");
    expect(out!.recommendation).toContain("api.chat.tsx");
    expect(out!.recommendation.toLowerCase()).toContain("tool-only");
  });

  it("evidence carries count, sample IDs, and threshold metadata", () => {
    const ids = ["conv_a", "conv_b", "conv_c", "conv_d", "conv_e"];
    const out = buildMissingTitleFinding({
      count: 7,
      sampleConversationIds: ids,
    });
    expect(out!.evidence).toEqual({
      count: 7,
      sampleConversationIds: ids,
      thresholdHours: 24,
      thresholdMinMessages: 4,
      thresholdMinCount: MISSING_TITLE_MIN_COUNT,
    });
  });

  it("preserves the order of sample IDs (oldest-first ranking from the scan)", () => {
    const out = buildMissingTitleFinding({
      count: 3,
      sampleConversationIds: ["oldest", "middle", "newest"],
    });
    expect((out!.evidence as { sampleConversationIds: string[] }).sampleConversationIds).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
  });
});

describe("pickWorstToolFailure", () => {
  function cand(over: Partial<ToolFailureCandidate> = {}): ToolFailureCandidate {
    return {
      toolName: "update_product_price",
      failures24h: 0,
      baselinePer24h: 0,
      sampleAuditLogIds: [],
      ...over,
    };
  }

  it("returns null when no candidate crosses the threshold", () => {
    const out = pickWorstToolFailure([
      cand({ toolName: "a", failures24h: TOOL_FAILURE_FLOOR - 1 }),
      cand({ toolName: "b", failures24h: 0 }),
    ]);
    expect(out).toBeNull();
  });

  it("fires at the floor for tools with zero baseline (new-failure regression)", () => {
    const out = pickWorstToolFailure([
      cand({ toolName: "a", failures24h: TOOL_FAILURE_FLOOR, baselinePer24h: 0 }),
    ]);
    expect(out).not.toBeNull();
    expect(out!.toolName).toBe("a");
  });

  it("requires 3x baseline for tools that legitimately fail occasionally", () => {
    // Tool with 2/24h baseline. 5 failures shouldn't fire (2*3=6 threshold).
    const just_under = pickWorstToolFailure([
      cand({ toolName: "a", failures24h: 5, baselinePer24h: 2 }),
    ]);
    expect(just_under).toBeNull();
    // 6 failures fires (meets 2*3).
    const at = pickWorstToolFailure([
      cand({ toolName: "a", failures24h: 6, baselinePer24h: 2 }),
    ]);
    expect(at).not.toBeNull();
  });

  it("picks the highest-failure tool when multiple cross the threshold", () => {
    const out = pickWorstToolFailure([
      cand({ toolName: "low", failures24h: 4, baselinePer24h: 0 }),
      cand({ toolName: "high", failures24h: 15, baselinePer24h: 0 }),
      cand({ toolName: "mid", failures24h: 8, baselinePer24h: 0 }),
    ]);
    expect(out!.toolName).toBe("high");
  });
});

describe("buildToolFailureFinding", () => {
  function c(over: Partial<ToolFailureCandidate> = {}): ToolFailureCandidate {
    return {
      toolName: "update_product_price",
      failures24h: 5,
      baselinePer24h: 0,
      sampleAuditLogIds: ["al_1", "al_2"],
      ...over,
    };
  }

  it("severity is warn under the critical-count threshold", () => {
    const out = buildToolFailureFinding(c({ failures24h: TOOL_FAILURE_CRITICAL_AT - 1 }));
    expect(out.severity).toBe("warn");
  });

  it("severity is critical at and above the critical-count threshold", () => {
    const out = buildToolFailureFinding(c({ failures24h: TOOL_FAILURE_CRITICAL_AT }));
    expect(out.severity).toBe("critical");
    const out2 = buildToolFailureFinding(c({ failures24h: 50 }));
    expect(out2.severity).toBe("critical");
  });

  it("message mentions the toolName, failure count, and baseline", () => {
    const out = buildToolFailureFinding(
      c({ toolName: "create_discount", failures24h: 12, baselinePer24h: 1.5 }),
    );
    expect(out.message).toContain("create_discount");
    expect(out.message).toContain("12");
    expect(out.message).toContain("1.5");
  });

  it("recommendation points the operator at the executor and shopify modules", () => {
    const out = buildToolFailureFinding(c());
    expect(out.recommendation).toContain("executor.server.ts");
    expect(out.recommendation).toContain("app/lib/shopify");
  });
});

describe("classifyLatency", () => {
  function c(over: Partial<LatencyCandidate> = {}): LatencyCandidate {
    return {
      modelUsed: "gemini-2.5-flash",
      p50: 2000,
      p95: 5000,
      p99: 8000,
      sampleSize: 100,
      ...over,
    };
  }

  it("returns null for unknown models (don't false-positive on new model rollouts)", () => {
    expect(classifyLatency(c({ modelUsed: "made-up-model" }))).toBeNull();
  });

  it("returns null below min sample size (percentile too noisy)", () => {
    expect(classifyLatency(c({ sampleSize: LATENCY_MIN_SAMPLE - 1, p95: 99999 }))).toBeNull();
  });

  it("returns null when p95 is under the warn threshold", () => {
    // gemini-2.5-flash warn=12000, p95=5000 → fine.
    expect(classifyLatency(c({ p95: 5000 }))).toBeNull();
  });

  it("classifies as warn when p95 is between warn and critical", () => {
    const out = classifyLatency(c({ p95: 15000 })); // flash warn=12000, critical=24000
    expect(out!.severity).toBe("warn");
  });

  it("classifies as critical when p95 is at or above critical threshold", () => {
    const out = classifyLatency(c({ p95: 24000 })); // exactly critical
    expect(out!.severity).toBe("critical");
    const out2 = classifyLatency(c({ p95: 30000 })); // way above
    expect(out2!.severity).toBe("critical");
  });

  it("uses lite-specific thresholds for gemini-2.5-flash-lite", () => {
    // lite warn=6000, critical=12000. p95=8000 should warn (above lite warn,
    // but below flash warn — wrong threshold would say "fine").
    const out = classifyLatency(
      c({ modelUsed: "gemini-2.5-flash-lite", p95: 8000 }),
    );
    expect(out!.severity).toBe("warn");
  });
});

describe("buildLatencyFinding", () => {
  it("renders message in seconds with 1-decimal precision", () => {
    const out = buildLatencyFinding(
      {
        modelUsed: "gemini-2.5-flash",
        p50: 1000,
        p95: 15500,
        p99: 20000,
        sampleSize: 60,
      },
      { severity: "warn", warnAt: 12000, criticalAt: 24000 },
    );
    expect(out.message).toContain("15.5s");
    expect(out.message).toContain("gemini-2.5-flash");
    expect(out.message).toContain("60");
  });

  it("evidence reports rounded ms values + thresholds", () => {
    const out = buildLatencyFinding(
      {
        modelUsed: "gemini-2.5-flash-lite",
        p50: 800.7,
        p95: 7500.2,
        p99: 11999.9,
        sampleSize: 42,
      },
      { severity: "warn", warnAt: 6000, criticalAt: 12000 },
    );
    expect(out.evidence).toEqual({
      modelUsed: "gemini-2.5-flash-lite",
      p50Ms: 801,
      p95Ms: 7500,
      p99Ms: 12000,
      sampleSize: 42,
      warnThresholdMs: 6000,
      criticalThresholdMs: 12000,
    });
  });
});

describe("buildStaleAnomalyFinding", () => {
  const baseOldest = {
    oldestId: "ins_old",
    oldestCreatedAt: new Date("2026-04-01T00:00:00Z"),
  };

  it("returns null below threshold", () => {
    expect(
      buildStaleAnomalyFinding({
        staleCount: STALE_ANOMALY_MIN_COUNT - 1,
        ...baseOldest,
      }),
    ).toBeNull();
  });

  it("severity is info (operator-facing meta-signal, not breakage)", () => {
    const out = buildStaleAnomalyFinding({
      staleCount: STALE_ANOMALY_MIN_COUNT,
      ...baseOldest,
    });
    expect(out!.severity).toBe("info");
  });

  it("recommendation routes the operator to both insights and memory pages", () => {
    const out = buildStaleAnomalyFinding({ staleCount: 5, ...baseOldest });
    expect(out!.recommendation).toContain("/app/settings/insights");
    expect(out!.recommendation).toContain("/app/settings/memory");
  });
});

describe("pickWorstRejectionPattern", () => {
  function rc(over: Partial<RejectionCandidate> = {}): RejectionCandidate {
    return {
      toolName: "update_product_price",
      totalExecuted7d: 5,
      totalRejected7d: 15,
      rejectionRate: 0.75,
      ...over,
    };
  }

  it("returns null when no candidate crosses BOTH thresholds", () => {
    // High rate but low absolute count.
    const lowCount = pickWorstRejectionPattern([
      rc({ totalRejected7d: REJECTION_MIN_COUNT - 1, rejectionRate: 0.99 }),
    ]);
    expect(lowCount).toBeNull();
    // High count but low rate.
    const lowRate = pickWorstRejectionPattern([
      rc({ totalRejected7d: 100, rejectionRate: 0.3 }),
    ]);
    expect(lowRate).toBeNull();
  });

  it("fires when both thresholds are crossed (boundary)", () => {
    const out = pickWorstRejectionPattern([
      rc({ totalRejected7d: REJECTION_MIN_COUNT, rejectionRate: 0.5 }),
    ]);
    expect(out).not.toBeNull();
  });

  it("picks the highest-rejection-count tool when multiple cross", () => {
    const out = pickWorstRejectionPattern([
      rc({ toolName: "small", totalRejected7d: 12, rejectionRate: 0.6 }),
      rc({ toolName: "huge", totalRejected7d: 80, rejectionRate: 0.7 }),
      rc({ toolName: "mid", totalRejected7d: 25, rejectionRate: 0.85 }),
    ]);
    expect(out!.toolName).toBe("huge");
  });
});

describe("parseRejectionResponse", () => {
  it("parses a clean hypothesis", () => {
    const raw = JSON.stringify({
      hypothesis: "Rejected when discount exceeds 30%.",
    });
    expect(parseRejectionResponse(raw)).toBe("Rejected when discount exceeds 30%.");
  });

  it("parses a null hypothesis (model couldn't find a pattern)", () => {
    expect(parseRejectionResponse('{ "hypothesis": null }')).toBeNull();
  });

  it("strips ```json code fences (Flash-Lite occasionally adds them)", () => {
    const raw = '```json\n{"hypothesis":"Rejected on first message."}\n```';
    expect(parseRejectionResponse(raw)).toBe("Rejected on first message.");
  });

  it("returns null on malformed JSON (fail-soft)", () => {
    expect(parseRejectionResponse("not json")).toBeNull();
    expect(parseRejectionResponse("{ broken")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseRejectionResponse("")).toBeNull();
    expect(parseRejectionResponse("   ")).toBeNull();
  });

  it("returns null when schema validation fails (missing field)", () => {
    expect(parseRejectionResponse('{ "wrong_key": "x" }')).toBeNull();
  });

  it("returns null when hypothesis is too long (Zod max 400)", () => {
    const long = "x".repeat(500);
    expect(parseRejectionResponse(JSON.stringify({ hypothesis: long }))).toBeNull();
  });
});

describe("buildRejectionUserMessage", () => {
  it("includes toolName and numbered rejection samples", () => {
    const msg = buildRejectionUserMessage("create_discount", [
      { discount: 0.4 },
      { discount: 0.5 },
    ]);
    expect(msg).toContain("create_discount");
    expect(msg).toContain("Rejection 1:");
    expect(msg).toContain("Rejection 2:");
    expect(msg).toContain('"discount":0.4');
  });

  it("truncates very long inputs with an ellipsis", () => {
    const big = { x: "y".repeat(2000) };
    const msg = buildRejectionUserMessage("t", [big]);
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(2000); // header + truncated body, not full
  });

  it("handles unstringifiable input without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const msg = buildRejectionUserMessage("t", [circular]);
    expect(msg).toContain("[unstringifiable input]");
  });
});

describe("buildToolRejectionFinding", () => {
  function c(over: Partial<RejectionCandidate> = {}): RejectionCandidate {
    return {
      toolName: "update_product_price",
      totalExecuted7d: 8,
      totalRejected7d: 12,
      rejectionRate: 0.6,
      ...over,
    };
  }

  it("severity is always warn (behavioral, not breakage)", () => {
    expect(buildToolRejectionFinding(c(), null).severity).toBe("warn");
    expect(
      buildToolRejectionFinding(c({ totalRejected7d: 500 }), "any pattern").severity,
    ).toBe("warn");
  });

  it("message includes rejection count, total, and percentage", () => {
    const out = buildToolRejectionFinding(
      c({ totalRejected7d: 60, totalExecuted7d: 40, rejectionRate: 0.6 }),
      null,
    );
    expect(out.message).toContain("60 of 100"); // 60 rejected of 100 total
    expect(out.message).toContain("60%");
  });

  it("recommendation includes the LLM hypothesis when present", () => {
    const out = buildToolRejectionFinding(
      c(),
      "Rejected when discount exceeds 30%.",
    );
    expect(out.recommendation).toContain("Rejected when discount exceeds 30%.");
  });

  it("recommendation falls back to manual inspection when hypothesis is null (fail-soft)", () => {
    const out = buildToolRejectionFinding(c(), null);
    expect(out.recommendation).toContain("PendingAction");
    expect(out.recommendation).toContain("manually");
  });

  it("evidence carries llmHypothesis: null when LLM failed", () => {
    const out = buildToolRejectionFinding(c(), null);
    expect((out.evidence as { llmHypothesis: string | null }).llmHypothesis).toBeNull();
  });

  it("evidence carries the actual hypothesis when present", () => {
    const out = buildToolRejectionFinding(c(), "Rejected on draft products.");
    expect((out.evidence as { llmHypothesis: string | null }).llmHypothesis).toBe(
      "Rejected on draft products.",
    );
  });
});
