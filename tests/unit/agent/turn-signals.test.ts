import { describe, expect, it } from "vitest";

import {
  classifyTurnOutcome,
  countToolCalls,
  extractMaxConfidence,
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

describe("extractMaxConfidence", () => {
  it("returns null on empty / no-tag text", () => {
    expect(extractMaxConfidence("")).toBeNull();
    expect(extractMaxConfidence("hello world")).toBeNull();
    expect(
      extractMaxConfidence("Cat Food's description is now live."),
    ).toBeNull();
  });

  it("extracts a single confidence tag in the canonical italic format", () => {
    const t =
      "I'd raise the price to $24.99.\n\n*Confidence: 0.6 — based on 30-day analytics.*";
    expect(extractMaxConfidence(t)).toBe(0.6);
  });

  it("is case-insensitive on the literal 'Confidence'", () => {
    expect(extractMaxConfidence("confidence: 0.7")).toBe(0.7);
    expect(extractMaxConfidence("CONFIDENCE: 0.7")).toBe(0.7);
    expect(extractMaxConfidence("Confidence: 0.7")).toBe(0.7);
  });

  it("accepts both 0.6 and .6 forms", () => {
    expect(extractMaxConfidence("Confidence: .6 — gut feeling")).toBe(0.6);
    expect(extractMaxConfidence("Confidence: 0.6 — gut feeling")).toBe(0.6);
  });

  it("returns the HIGHEST confidence when multiple tags appear", () => {
    const t = `
Plan for catalog cleanup:
1. Drop $5 floor on items currently above $5.
   *Confidence: 0.5 — store-wide policy is conservative here.*
2. Pause the discount campaign on Hoodies.
   *Confidence: 0.85 — backed by Insight ins_42 (significanceP=0.04).*
`;
    expect(extractMaxConfidence(t)).toBe(0.85);
  });

  it("clamps values above 1 (CEO accidentally writes 95 thinking percent)", () => {
    expect(extractMaxConfidence("Confidence: 95")).toBe(1);
    expect(extractMaxConfidence("Confidence: 1.5")).toBe(1);
  });

  it("returns null on a negative-signed value (regex doesn't accept the minus; safer than picking up the '0.2' suffix)", () => {
    // Defensive — should never happen, but if the CEO writes a malformed
    // tag we want null (no confidence detected) rather than a value of
    // dubious provenance.
    expect(extractMaxConfidence("Confidence: -0.2")).toBeNull();
  });

  it("ignores garbage that follows the colon", () => {
    expect(extractMaxConfidence("Confidence: 0.6")).toBe(0.6);
    expect(extractMaxConfidence("Confidence:0.6 because reasons")).toBe(0.6);
    expect(
      extractMaxConfidence("Confidence: 0.6 — long reason that runs on"),
    ).toBe(0.6);
  });

  it("handles tag wrapped in markdown asterisks (italics) correctly", () => {
    expect(extractMaxConfidence("*Confidence: 0.7*")).toBe(0.7);
    expect(extractMaxConfidence("**Confidence: 0.7**")).toBe(0.7);
    expect(extractMaxConfidence("_Confidence: 0.7_")).toBe(0.7);
  });

  it("does NOT match unrelated occurrences of the word 'confidence'", () => {
    // No colon → not the tag pattern. The CEO might write "confidence in the
    // data" prose; we shouldn't pick stray numbers nearby as confidence.
    expect(
      extractMaxConfidence(
        "I have confidence in this approach because of the 30-day trend.",
      ),
    ).toBeNull();
  });

  it("returns null when the tag is malformed (no number)", () => {
    expect(extractMaxConfidence("Confidence: high")).toBeNull();
    expect(extractMaxConfidence("Confidence:")).toBeNull();
  });
});
