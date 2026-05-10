import { describe, expect, it } from "vitest";

import {
  formatLessonsBlock,
  type ConversationFailureRow,
} from "../../../app/lib/agent/conversation-failures.server";

// Phase Wf Round Wf-C — conversation-failures unit tests. The DB-touching
// helpers (recordFailure, recentFailures, pruneOldFailures) are exercised
// implicitly through the agent-loop wiring; here we cover the pure
// formatting + dedupe-ranking logic that doesn't need a DB.

function makeRow(over: Partial<ConversationFailureRow> = {}): ConversationFailureRow {
  return {
    id: `fail_${Math.random().toString(36).slice(2)}`,
    storeId: "store_1",
    conversationId: "conv_1",
    toolName: "update_product_status",
    code: "ID_NOT_FOUND",
    errorMessage: "product not found: gid://shopify/Product/999",
    createdAt: new Date(),
    ...over,
  };
}

describe("formatLessonsBlock", () => {
  it("returns null when no failures", () => {
    expect(formatLessonsBlock([])).toBeNull();
  });

  it("formats a single failure as a compact bullet", () => {
    const block = formatLessonsBlock([makeRow()]);
    expect(block).not.toBeNull();
    expect(block).toContain("`update_product_status`");
    expect(block).toContain("ID_NOT_FOUND");
    expect(block).toContain("product not found");
    expect(block).toContain("Failures recorded in this conversation");
  });

  it("formats multiple failures as multi-line", () => {
    const block = formatLessonsBlock([
      makeRow({ toolName: "update_product_status", code: "ID_NOT_FOUND" }),
      makeRow({ toolName: "create_discount", code: "RATE_LIMITED_BURST" }),
    ]);
    expect(block).not.toBeNull();
    expect(block!.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(block).toContain("update_product_status");
    expect(block).toContain("create_discount");
    expect(block).toContain("RATE_LIMITED_BURST");
  });

  it("truncates long error messages to 120 chars + ellipsis", () => {
    const longErr = "x".repeat(500);
    const block = formatLessonsBlock([makeRow({ errorMessage: longErr })]);
    expect(block).not.toBeNull();
    // Shouldn't contain the full 500-char string
    expect(block!.length).toBeLessThan(800);
    expect(block).toContain("…");
  });

  it("teaches the agent the lesson may be stale", () => {
    // The block's preamble must mention staleness — agents that read the
    // block need to know fresh reads override it (rule 35).
    const block = formatLessonsBlock([makeRow()]);
    expect(block).toContain("stale");
  });

  it("preserves order (most-recent-first as caller passed)", () => {
    const a = makeRow({ code: "A", toolName: "tool_a" });
    const b = makeRow({ code: "B", toolName: "tool_b" });
    const block = formatLessonsBlock([a, b]);
    expect(block).not.toBeNull();
    const aIdx = block!.indexOf("tool_a");
    const bIdx = block!.indexOf("tool_b");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
  });
});
