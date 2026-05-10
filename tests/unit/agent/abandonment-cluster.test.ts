import { describe, expect, it } from "vitest";

import {
  cosineDistance,
  dbscan,
  summarizeCluster,
} from "../../../app/lib/agent/abandonment/cluster.server";
import type { AbandonedTurnRow } from "../../../app/lib/agent/abandonment/types";

type EmbeddedTurn = AbandonedTurnRow & { embedding: number[] };

function turn(
  id: string,
  embedding: number[],
  overrides: Partial<EmbeddedTurn> = {},
): EmbeddedTurn {
  return {
    turnSignalId: id,
    messageId: `m-${id}`,
    conversationId: `c-${id}`,
    userMessage: `msg-${id}`,
    outcome: "abandoned",
    toolNamesUsed: [],
    routerReason: null,
    latencyMs: null,
    createdAt: new Date(),
    embedding,
    ...overrides,
  };
}

describe("cosineDistance", () => {
  it("returns 0 for identical unit vectors", () => {
    expect(cosineDistance([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 6);
  });

  it("returns 1 for orthogonal vectors", () => {
    expect(cosineDistance([1, 0, 0], [0, 1, 0])).toBeCloseTo(1, 6);
  });

  it("returns 2 for opposite-direction vectors", () => {
    expect(cosineDistance([1, 0, 0], [-1, 0, 0])).toBeCloseTo(2, 6);
  });

  it("returns 1 for any vector vs zero vector (avoids NaN)", () => {
    expect(cosineDistance([1, 2, 3], [0, 0, 0])).toBe(1);
  });

  it("throws on dim mismatch", () => {
    expect(() => cosineDistance([1, 2], [1, 2, 3])).toThrow();
  });
});

describe("dbscan", () => {
  it("groups close points into one cluster, leaves far points as noise", () => {
    // Two tight clusters around [1,0,...] and [0,1,...]; one outlier
    const points = [
      turn("a1", [1, 0, 0]),
      turn("a2", [0.99, 0.01, 0]),
      turn("a3", [0.98, 0.02, 0]),
      turn("b1", [0, 1, 0]),
      turn("b2", [0.01, 0.99, 0]),
      turn("b3", [0.02, 0.98, 0]),
      turn("outlier", [0, 0, 1]),
    ];
    const groups = dbscan(points, 0.15, 3);
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([3, 3]);
    // Outlier is not in any cluster (noise).
    const allInClusters = new Set(groups.flat().map((p) => p.turnSignalId));
    expect(allInClusters.has("outlier")).toBe(false);
  });

  it("returns no clusters when below minPts", () => {
    const points = [
      turn("a1", [1, 0, 0]),
      turn("a2", [0.99, 0.01, 0]),
    ];
    const groups = dbscan(points, 0.15, 3);
    expect(groups).toEqual([]);
  });

  it("expands cluster transitively through reachable neighbors", () => {
    // Chain: a1 ~ a2 ~ a3 ~ a4 — even though a1 and a4 are far apart,
    // density-reachability should put them in the same cluster.
    const points = [
      turn("a1", [1, 0, 0, 0]),
      turn("a2", [0.95, 0.05, 0, 0]),
      turn("a3", [0.90, 0.10, 0, 0]),
      turn("a4", [0.85, 0.15, 0, 0]),
    ];
    const groups = dbscan(points, 0.05, 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].length).toBeGreaterThanOrEqual(3);
  });
});

describe("summarizeCluster", () => {
  it("computes size and centroid from cluster members", () => {
    const turns = [
      turn("a1", [1, 0, 0]),
      turn("a2", [0.5, 0.5, 0]),
      turn("a3", [0, 1, 0]),
    ];
    const c = summarizeCluster(turns);
    expect(c.size).toBe(3);
    expect(c.centroidEmbedding).toHaveLength(3);
    expect(c.centroidEmbedding[0]).toBeCloseTo(0.5, 6);
    expect(c.centroidEmbedding[1]).toBeCloseTo(0.5, 6);
  });

  it("picks at most 5 sample turns ordered by closeness to centroid", () => {
    const turns = [
      turn("close", [1, 0, 0]),
      turn("medium", [0.8, 0.2, 0]),
      turn("far", [0, 1, 0]),
    ];
    const c = summarizeCluster(turns);
    expect(c.sampleTurnIds.length).toBeLessThanOrEqual(5);
    expect(c.sampleTurnIds[0]).toBe("medium"); // closest to centroid (avg)
  });

  it("flags tools that appear in ≥ 50% of cluster turns", () => {
    const turns = [
      turn("a1", [1, 0], { toolNamesUsed: ["read_products", "delegate_to_department"] }),
      turn("a2", [1, 0], { toolNamesUsed: ["read_products"] }),
      turn("a3", [1, 0], { toolNamesUsed: ["ask_clarifying_question"] }),
    ];
    const c = summarizeCluster(turns);
    expect(c.commonTools).toContain("read_products"); // 2 of 3 turns
    expect(c.commonTools).not.toContain("delegate_to_department"); // only 1 of 3
  });

  it("flags router reason only when plurality clears 30%", () => {
    const allDefault = [
      turn("a1", [1, 0], { routerReason: "default" }),
      turn("a2", [1, 0], { routerReason: "default" }),
      turn("a3", [1, 0], { routerReason: "default" }),
    ];
    expect(summarizeCluster(allDefault).commonRouterReason).toBe("default");

    const noPlurality = [
      turn("a1", [1, 0], { routerReason: "a" }),
      turn("a2", [1, 0], { routerReason: "b" }),
      turn("a3", [1, 0], { routerReason: "c" }),
    ];
    // Each at 33% of 3 = topCount=1 ≥ 0.9 (size*0.3=0.9) — borderline pass.
    // Verify the helper picks SOME reason for the plurality (non-null).
    expect(summarizeCluster(noPlurality).commonRouterReason).not.toBeNull();
  });

  it("returns null commonRouterReason when no turn has a routerReason", () => {
    const turns = [
      turn("a1", [1, 0]),
      turn("a2", [1, 0]),
      turn("a3", [1, 0]),
    ];
    expect(summarizeCluster(turns).commonRouterReason).toBeNull();
  });

  it("dominantOutcome picks the more-frequent outcome", () => {
    const moreAbandoned = [
      turn("a1", [1, 0], { outcome: "abandoned" }),
      turn("a2", [1, 0], { outcome: "abandoned" }),
      turn("a3", [1, 0], { outcome: "clarified" }),
    ];
    expect(summarizeCluster(moreAbandoned).dominantOutcome).toBe("abandoned");

    const moreClarified = [
      turn("a1", [1, 0], { outcome: "clarified" }),
      turn("a2", [1, 0], { outcome: "clarified" }),
      turn("a3", [1, 0], { outcome: "abandoned" }),
    ];
    expect(summarizeCluster(moreClarified).dominantOutcome).toBe("clarified");
  });

  it("fingerprint is deterministic across reruns of same cluster", () => {
    const turns = [
      turn("a1", [0.123456, 0.234567, 0.345678, 0.456789, 0]),
      turn("a2", [0.123456, 0.234567, 0.345678, 0.456789, 0]),
      turn("a3", [0.123456, 0.234567, 0.345678, 0.456789, 0]),
    ];
    const fp1 = summarizeCluster(turns).fingerprint;
    const fp2 = summarizeCluster(turns).fingerprint;
    expect(fp1).toBe(fp2);
    expect(fp1.split("|")).toHaveLength(4);
  });
});
