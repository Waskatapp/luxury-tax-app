import { describe, expect, it } from "vitest";

import {
  classifyTurnOutcome,
  countToolCalls,
  hasClarificationCall,
  hasWriteToolCall,
} from "../../../app/lib/agent/turn-signals.server";
import type { ContentBlock } from "../../../app/lib/agent/translate.server";

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

function toolUse(
  name: string,
  id: string = `${name}::id`,
  input: Record<string, unknown> = {},
): ContentBlock {
  return { type: "tool_use", id, name, input };
}

describe("classifyTurnOutcome", () => {
  it("returns 'informational' for a pure-text turn", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [text("here are your products: …")],
        pendingActions: [],
      }),
    ).toBe("informational");
  });

  it("returns 'informational' for a read-only tool turn (no writes, no clarify)", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [
          toolUse("read_products"),
          text("Here are 3 matches:"),
        ],
        pendingActions: [],
      }),
    ).toBe("informational");
  });

  it("returns 'clarified' when ask_clarifying_question fired", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [
          text("Quick question first:"),
          toolUse("ask_clarifying_question"),
        ],
        pendingActions: [],
      }),
    ).toBe("clarified");
  });

  it("returns 'approved' when any write reached EXECUTED", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [
          text("Updating that price."),
          toolUse("update_product_price", "update_product_price::abc"),
        ],
        pendingActions: [
          { toolCallId: "update_product_price::abc", status: "EXECUTED" },
        ],
      }),
    ).toBe("approved");
  });

  it("returns 'approved' even if other writes failed (any-executed wins)", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [
          toolUse("update_product_price", "update_product_price::a"),
          toolUse("update_product_price", "update_product_price::b"),
        ],
        pendingActions: [
          { toolCallId: "update_product_price::a", status: "EXECUTED" },
          { toolCallId: "update_product_price::b", status: "FAILED" },
        ],
      }),
    ).toBe("approved");
  });

  it("returns 'rejected' when every write was REJECTED or FAILED (none EXECUTED)", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [
          toolUse("update_product_price", "update_product_price::a"),
        ],
        pendingActions: [
          { toolCallId: "update_product_price::a", status: "REJECTED" },
        ],
      }),
    ).toBe("rejected");
  });

  it("treats FAILED as a 'rejected' signal", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [toolUse("create_discount")],
        pendingActions: [
          { toolCallId: "create_discount::id", status: "FAILED" },
        ],
      }),
    ).toBe("rejected");
  });

  it("returns 'informational' (provisional) when writes are still PENDING", () => {
    // At SSE-done time the merchant hasn't clicked Approve/Reject yet —
    // writes sit at PENDING. Promotion to approved/rejected is the
    // tool-approve/tool-reject route's job.
    expect(
      classifyTurnOutcome({
        assistantContent: [
          toolUse("update_product_price", "update_product_price::a"),
        ],
        pendingActions: [
          { toolCallId: "update_product_price::a", status: "PENDING" },
        ],
      }),
    ).toBe("informational");
  });

  it("EXECUTED wins over a same-turn clarification (defensive — agent loop should never produce this combo, but the priority is well-defined)", () => {
    expect(
      classifyTurnOutcome({
        assistantContent: [
          toolUse("ask_clarifying_question"),
          toolUse("update_product_price", "update_product_price::a"),
        ],
        pendingActions: [
          { toolCallId: "update_product_price::a", status: "EXECUTED" },
        ],
      }),
    ).toBe("approved");
  });
});

describe("countToolCalls / hasWriteToolCall / hasClarificationCall", () => {
  it("counts tool_use blocks ignoring text", () => {
    expect(
      countToolCalls([
        text("hi"),
        toolUse("read_products"),
        toolUse("read_collections"),
      ]),
    ).toBe(2);
  });

  it("hasWriteToolCall is true only for approval-required writes", () => {
    expect(
      hasWriteToolCall([
        toolUse("read_products"),
        toolUse("update_store_memory"), // inline, NOT counted as approval-required
      ]),
    ).toBe(false);
    expect(
      hasWriteToolCall([toolUse("update_product_price")]),
    ).toBe(true);
  });

  it("hasClarificationCall detects ask_clarifying_question", () => {
    expect(
      hasClarificationCall([toolUse("ask_clarifying_question")]),
    ).toBe(true);
    expect(hasClarificationCall([toolUse("read_products")])).toBe(false);
  });
});
