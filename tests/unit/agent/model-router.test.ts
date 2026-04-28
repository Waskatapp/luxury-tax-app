import { describe, expect, it } from "vitest";

import { pickModelTier } from "../../../app/lib/agent/model-router";
import {
  GEMINI_CHAT_MODEL,
  GEMINI_MEMORY_MODEL,
} from "../../../app/lib/agent/gemini.server";

const FLASH = GEMINI_CHAT_MODEL;
const LITE = GEMINI_MEMORY_MODEL;

function input(over: Partial<Parameters<typeof pickModelTier>[0]> = {}) {
  return {
    message: "show me my products",
    hasActivePlan: false,
    recentWriteToolUse: false,
    ...over,
  };
}

describe("pickModelTier — quality-floor heuristics", () => {
  it("active plan → Flash regardless of message shape", () => {
    const r = pickModelTier(input({ message: "show me", hasActivePlan: true }));
    expect(r.tier).toBe("flash");
    expect(r.modelId).toBe(FLASH);
    expect(r.reason).toContain("active plan");
  });

  it("recent write tool use → Flash regardless of message shape", () => {
    const r = pickModelTier(
      input({ message: "show me", recentWriteToolUse: true }),
    );
    expect(r.tier).toBe("flash");
    expect(r.reason).toContain("recent write");
  });

  it("long message (>200 chars) → Flash even on simple lead-in word", () => {
    const longMsg = "show me " + "x".repeat(250);
    const r = pickModelTier(input({ message: longMsg }));
    expect(r.tier).toBe("flash");
    expect(r.reason).toContain("length");
  });
});

describe("pickModelTier — slash command tier hints", () => {
  it.each([
    ["/audit", "flash"],
    ["/audit pricing", "flash"],
    ["/draft cat food", "flash"],
    ["/discount", "flash"],
    ["/insights", "flash-lite"],
    ["/insights 7 days", "flash-lite"],
    ["/memory", "flash-lite"],
    ["/diff", "flash-lite"],
  ] as const)("%s → %s", (msg, expectedTier) => {
    const r = pickModelTier(input({ message: msg }));
    expect(r.tier).toBe(expectedTier);
    expect(r.reason).toContain("slash:");
  });

  it("slash hint overrides length heuristic (when applicable)", () => {
    // /insights with extra context that pushes >200 chars — slash hint
    // wins because we know /insights is a read-only summary.
    const longArg = "with " + "x".repeat(250);
    const r = pickModelTier(input({ message: `/insights ${longArg}` }));
    expect(r.tier).toBe("flash-lite");
  });
});

describe("pickModelTier — first-word heuristics", () => {
  it.each([
    "show me my products",
    "list my collections",
    "what's my revenue",
    "which products are out of stock",
    "who is the vendor for cat food",
    "where is my Vancouver inventory",
    "when did I last update prices",
    "summarize my brand voice",
  ])("simple lead-in: %j → Flash-Lite", (msg) => {
    const r = pickModelTier(input({ message: msg }));
    expect(r.tier).toBe("flash-lite");
    expect(r.reason).toContain("first-word");
  });

  it.each([
    "how many products do I have",
    "how much did I make",
  ])("multi-word prefix: %j → Flash-Lite", (msg) => {
    const r = pickModelTier(input({ message: msg }));
    expect(r.tier).toBe("flash-lite");
    expect(r.reason).toContain("prefix");
  });

  it("strips trailing punctuation on the lead-in word", () => {
    expect(pickModelTier(input({ message: "show, me my products" })).tier).toBe(
      "flash-lite",
    );
  });
});

describe("pickModelTier — defaults", () => {
  it("default → Flash for everything else", () => {
    const r = pickModelTier(input({ message: "lower the price of cat food" }));
    expect(r.tier).toBe("flash");
    expect(r.modelId).toBe(FLASH);
    expect(r.reason).toBe("default");
  });

  it("never down-tiers an imperative (write-y verb)", () => {
    expect(pickModelTier(input({ message: "lower" })).tier).toBe("flash");
    expect(pickModelTier(input({ message: "create a discount" })).tier).toBe(
      "flash",
    );
    expect(pickModelTier(input({ message: "publish the draft" })).tier).toBe(
      "flash",
    );
  });

  it("modelId resolves correctly for both tiers", () => {
    expect(pickModelTier(input({ message: "show all" })).modelId).toBe(LITE);
    expect(pickModelTier(input({ message: "create" })).modelId).toBe(FLASH);
  });
});
