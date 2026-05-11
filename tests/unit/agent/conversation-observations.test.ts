import { describe, expect, it } from "vitest";

import {
  MAX_OBSERVATION_KIND_LEN,
  MAX_OBSERVATION_SUMMARY_LEN,
  formatObservationsBlock,
  type ConversationObservationRow,
} from "../../../app/lib/agent/conversation-observations.server";

// Phase Mn Round Mn-3 — conversation-observations unit tests. The
// DB-touching helpers (recordObservation, recentObservations,
// pruneOldObservations) are exercised implicitly through the agent-loop
// wiring; here we cover the pure formatting + size-bound contract that
// doesn't need a DB.

function makeRow(over: Partial<ConversationObservationRow> = {}): ConversationObservationRow {
  return {
    id: `obs_${Math.random().toString(36).slice(2)}`,
    storeId: "store_1",
    conversationId: "conv_1",
    kind: "catalog-summary",
    summary: "70 products in 5 categories: snowboards (15), winter gear (20), apparel (35).",
    sourceToolName: "read_products",
    createdAt: new Date(),
    ...over,
  };
}

describe("formatObservationsBlock", () => {
  it("returns null when no observations", () => {
    expect(formatObservationsBlock([])).toBeNull();
  });

  it("formats a single observation with kind, source tool, and summary", () => {
    const block = formatObservationsBlock([makeRow()]);
    expect(block).not.toBeNull();
    expect(block).toContain("**catalog-summary**");
    expect(block).toContain("`read_products`");
    expect(block).toContain("70 products in 5 categories");
    expect(block).toContain("learned earlier in this conversation");
  });

  it("formats an observation without sourceToolName cleanly", () => {
    const block = formatObservationsBlock([
      makeRow({ sourceToolName: null }),
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain("**catalog-summary**");
    expect(block).not.toContain("from `null`");
    expect(block).not.toContain("(from )");
  });

  it("formats multiple observations as multi-line", () => {
    const block = formatObservationsBlock([
      makeRow({ kind: "catalog-summary" }),
      makeRow({
        kind: "top-sellers",
        summary: "Top 3: Cat Food, Dog Food, Bird Seed",
        sourceToolName: "get_top_performers",
      }),
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain("catalog-summary");
    expect(block).toContain("top-sellers");
    expect(block).toContain("Top 3: Cat Food");
    expect(block!.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("includes a staleness warning so the agent re-reads when state must be current", () => {
    const block = formatObservationsBlock([makeRow()]);
    expect(block).toContain("stale");
  });
});

describe("Mn-3 constants", () => {
  it("exposes the kind + summary length caps as code constants", () => {
    expect(MAX_OBSERVATION_KIND_LEN).toBe(40);
    expect(MAX_OBSERVATION_SUMMARY_LEN).toBe(500);
  });
});
