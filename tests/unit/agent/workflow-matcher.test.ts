import { describe, expect, it } from "vitest";

import {
  formatTriggerSuggestionsBlock,
  matchTriggers,
  tokenize,
} from "../../../app/lib/agent/workflow-matcher.server";
import type { WorkflowIndexEntry } from "../../../app/lib/agent/workflow-loader.server";

// Phase Wf Round Wf-A — workflow trigger matcher tests.
// Whole-word matching, multi-message context, priority tie-break.

function entry(over: Partial<WorkflowIndexEntry> = {}): WorkflowIndexEntry {
  return {
    name: "discount-creation",
    department: "pricing-promotions",
    summary: "Create a discount",
    toolName: "create_discount",
    triggers: ["discount", "promo", "sale"],
    priority: 5,
    ...over,
  };
}

describe("tokenize — whole-word boundary discipline", () => {
  it("splits on whitespace and strips punctuation", () => {
    expect(tokenize("Hello, world! How are you?")).toEqual([
      "hello",
      "world",
      "how",
      "are",
      "you",
    ]);
  });

  it("lowercases", () => {
    expect(tokenize("PRICE")).toEqual(["price"]);
  });

  it("handles hyphens by splitting (so 'promo-code' tokenizes to two tokens)", () => {
    expect(tokenize("promo-code")).toEqual(["promo", "code"]);
  });

  it("preserves digits", () => {
    expect(tokenize("set 25% off")).toEqual(["set", "25", "off"]);
  });

  it("handles apostrophes by stripping them", () => {
    expect(tokenize("don't sell that")).toEqual(["don", "t", "sell", "that"]);
  });
});

describe("matchTriggers — single-word triggers", () => {
  it("fires on whole-word match", () => {
    const matches = matchTriggers(
      "I want to set up a discount for the weekend",
      "",
      [entry()],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("discount-creation");
    expect(matches[0].matchedTriggers).toContain("discount");
  });

  it("does NOT fire on substring match (Plan-agent's appraised vs price test)", () => {
    const matches = matchTriggers(
      "I'm looking at my appraised products today",
      "",
      [entry({ triggers: ["price"], name: "price-change" })],
    );
    expect(matches).toHaveLength(0);
  });

  it("returns empty when no triggers fire", () => {
    expect(matchTriggers("hello there", "", [entry()])).toEqual([]);
  });

  it("returns empty when message is empty", () => {
    expect(matchTriggers("", "", [entry()])).toEqual([]);
    expect(matchTriggers("   ", "", [entry()])).toEqual([]);
  });
});

describe("matchTriggers — multi-word triggers", () => {
  it("fires when adjacent token sequence matches", () => {
    const matches = matchTriggers(
      "let's send a promo code to subscribers",
      "",
      [entry({ triggers: ["promo code"] })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedTriggers).toContain("promo code");
  });

  it("does NOT fire when tokens appear non-adjacent", () => {
    const matches = matchTriggers(
      "promo for our coupon code system",
      "",
      [entry({ triggers: ["promo code"] })],
    );
    // "promo" and "code" appear but not adjacent.
    expect(matches).toHaveLength(0);
  });
});

describe("matchTriggers — multi-message context", () => {
  it("uses last assistant message for follow-ups like 'do that for the rest'", () => {
    const matches = matchTriggers(
      "do that for the rest",
      "I lowered the price on cat food to $19.99",
      [entry({ triggers: ["price"], name: "price-change" })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("price-change");
  });

  it("caps assistant context length so a long prior turn doesn't dominate", () => {
    const longAssistant = "x".repeat(10_000) + " inventory";
    // "inventory" is past the 600-char cap → shouldn't fire.
    const matches = matchTriggers(
      "ok",
      longAssistant,
      [entry({ triggers: ["inventory"], name: "inventory-audit" })],
    );
    expect(matches).toHaveLength(0);
  });
});

describe("matchTriggers — ranking", () => {
  it("ranks by hit count desc (more triggers fired wins)", () => {
    const matches = matchTriggers(
      "set up a discount promo sale today",
      "",
      [
        entry({ name: "wf-one", triggers: ["discount"] }),
        entry({ name: "wf-two", triggers: ["discount", "promo", "sale"] }),
      ],
    );
    expect(matches[0].name).toBe("wf-two");
    expect(matches[0].hitCount).toBe(3);
  });

  it("breaks ties on priority desc", () => {
    const matches = matchTriggers(
      "discount please",
      "",
      [
        entry({ name: "low-pri", triggers: ["discount"], priority: 3 }),
        entry({ name: "hi-pri", triggers: ["discount"], priority: 8 }),
      ],
    );
    expect(matches[0].name).toBe("hi-pri");
  });

  it("breaks priority ties on name asc (stable)", () => {
    const matches = matchTriggers(
      "discount please",
      "",
      [
        entry({ name: "zebra", triggers: ["discount"] }),
        entry({ name: "alpha", triggers: ["discount"] }),
      ],
    );
    expect(matches[0].name).toBe("alpha");
  });

  it("respects the limit (default 3)", () => {
    const triggers = ["discount"];
    const wfs: WorkflowIndexEntry[] = Array.from({ length: 6 }, (_, i) =>
      entry({ name: `wf-${i}`, triggers }),
    );
    const matches = matchTriggers("discount", "", wfs);
    expect(matches).toHaveLength(3);
  });
});

describe("matchTriggers — index hygiene", () => {
  it("skips workflows with empty triggers arrays", () => {
    const matches = matchTriggers("discount", "", [
      entry({ triggers: [] }),
    ]);
    expect(matches).toEqual([]);
  });
});

describe("formatTriggerSuggestionsBlock", () => {
  it("returns null when no matches", () => {
    expect(formatTriggerSuggestionsBlock([])).toBeNull();
  });

  it("formats matches as compact bullet list", () => {
    const block = formatTriggerSuggestionsBlock([
      {
        name: "discount-creation",
        summary: "Create a discount",
        hitCount: 1,
        matchedTriggers: ["discount"],
        priority: 5,
      },
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain("`discount-creation`");
    expect(block).toContain("Create a discount");
    expect(block).toContain("matched: discount");
    expect(block).toContain("read_workflow");
  });
});
