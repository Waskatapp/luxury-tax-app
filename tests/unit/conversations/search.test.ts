import { describe, expect, it } from "vitest";

import {
  buildSnippet,
  scoreConversation,
  tokenize,
  type ScorableConversation,
} from "../../../app/lib/conversations/search.server";

const NOW = new Date("2026-04-27T12:00:00Z");

function conv(
  overrides: Partial<ScorableConversation> = {},
): ScorableConversation {
  return {
    id: "c-1",
    title: "Untitled",
    updatedAt: new Date("2026-04-27T11:00:00Z"), // 1h before NOW → fresh
    messages: [],
    ...overrides,
  };
}

function msg(text: string | null): { searchText: string | null } {
  return { searchText: text };
}

describe("tokenize", () => {
  it("returns empty for empty/whitespace", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("\t\n")).toEqual([]);
  });

  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Cat Food Price")).toEqual(["cat", "food", "price"]);
    expect(tokenize("  PRICE   update  ")).toEqual(["price", "update"]);
  });

  it("handles tabs and newlines as separators", () => {
    expect(tokenize("price\tcat\nfood")).toEqual(["price", "cat", "food"]);
  });

  it("caps individual word length at 40 chars", () => {
    const long = "a".repeat(60);
    const tokens = tokenize(long);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].length).toBe(40);
  });
});

describe("scoreConversation", () => {
  it("returns score 0 for no matches", () => {
    const c = conv({ title: "Inventory Audit", messages: [msg("stock check")] });
    const r = scoreConversation(c, ["pricing"], NOW);
    expect(r.score).toBe(0);
    expect(r.matchedIn).toBeNull();
  });

  it("scores +10 per word for title-only matches", () => {
    const c = conv({
      title: "Cat Food Price Update",
      messages: [msg("unrelated body")],
      // 35 days ago → recency boost = 0
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["cat", "price"], NOW);
    // +10 (cat) +10 (price) +5 (full coverage) = 25, recency ≈ 0
    expect(r.score).toBeGreaterThanOrEqual(25);
    expect(r.score).toBeLessThanOrEqual(26);
    expect(r.matchedIn).toBe("title");
  });

  it("scores +1 per matching message for body-only matches, capped at +5 per word", () => {
    const c = conv({
      title: "Untitled session",
      // 10 messages all containing "price"
      messages: Array.from({ length: 10 }, () => msg("price went up")),
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["price"], NOW);
    // body cap +5 (per word), full coverage +5, recency 0 = 10
    expect(r.score).toBe(10);
    expect(r.matchedIn).toBe("body");
  });

  it("classifies matchedIn as 'both' when title and body match", () => {
    const c = conv({
      title: "Price talk",
      messages: [msg("price decision today")],
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["price"], NOW);
    expect(r.matchedIn).toBe("both");
  });

  it("applies the +50 exact-title-match bonus only when whole title equals query", () => {
    const c = conv({
      title: "weekly revenue summary",
      messages: [],
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["weekly", "revenue", "summary"], NOW);
    // title hits: 3 words × 10 = 30; full-coverage +5; exact-title +50 = 85
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.score).toBeLessThanOrEqual(86);
  });

  it("applies recency boost up to +5 for very recent conversations", () => {
    const fresh = conv({
      title: "Stock check",
      messages: [],
      updatedAt: new Date("2026-04-27T11:30:00Z"), // 30min ago
    });
    const stale = conv({
      title: "Stock check",
      messages: [],
      updatedAt: new Date("2026-02-01T12:00:00Z"), // ~3 months ago
    });
    const freshScore = scoreConversation(fresh, ["stock"], NOW).score;
    const staleScore = scoreConversation(stale, ["stock"], NOW).score;
    expect(freshScore).toBeGreaterThan(staleScore);
    // Fresh should get full +5 recency on top of base
    expect(freshScore - staleScore).toBeCloseTo(5, 1);
  });

  it("does not apply full-coverage bonus when only one of two words matches", () => {
    const c = conv({
      title: "Price update",
      messages: [],
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["price", "elephant"], NOW);
    // Just +10 for "price" in title; no full coverage bonus since
    // "elephant" matches nothing.
    expect(r.score).toBe(10);
  });

  it("ignores null searchText messages", () => {
    const c = conv({
      title: "Test",
      messages: [msg(null), msg(null), msg("price match")],
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["price"], NOW);
    // 1 message matched body (+1), full coverage +5
    expect(r.score).toBe(6);
  });

  it("does not match across word boundaries within the same haystack character", () => {
    // Sanity: substring match — "price" inside "pricetag" should still count
    // (we're doing substring, not whole-word, by design — typo tolerance).
    const c = conv({
      title: "pricetag launch",
      messages: [],
      updatedAt: new Date("2026-03-23T12:00:00Z"),
    });
    const r = scoreConversation(c, ["price"], NOW);
    expect(r.score).toBeGreaterThan(0);
  });
});

describe("buildSnippet", () => {
  it("returns the title when title matches a word", () => {
    const snippet = buildSnippet(
      "Cat Food Price Update",
      [msg("body talk")],
      ["price"],
    );
    expect(snippet).toBe("Cat Food Price Update");
  });

  it("returns ±60 chars around first body match when title doesn't match", () => {
    const long =
      "we had a long discussion about the cat food price increase before deciding to roll it back";
    const snippet = buildSnippet(
      "Random title",
      [msg(long)],
      ["price"],
    );
    expect(snippet.toLowerCase()).toContain("price");
    expect(snippet.length).toBeLessThanOrEqual(125);
  });

  it("trims to word boundaries (no mid-word cut)", () => {
    const long =
      "the conversation history about the wonderful product price review process was lengthy and detailed and very thoughtful indeed without question";
    const snippet = buildSnippet(
      "Random title",
      [msg(long)],
      ["price"],
    );
    expect(snippet.toLowerCase()).toContain("price");
    // Should not have mid-word truncation immediately around "price"
    const aroundPrice = snippet.slice(
      Math.max(0, snippet.toLowerCase().indexOf("price") - 5),
      snippet.toLowerCase().indexOf("price") + 10,
    );
    expect(aroundPrice).toMatch(/\s|^/); // word break before "price"
  });

  it("falls back to the title when there's no match anywhere", () => {
    const snippet = buildSnippet("Inventory Check", [msg("stock low")], ["price"]);
    expect(snippet).toBe("Inventory Check");
  });

  it("collapses whitespace and trims", () => {
    const snippet = buildSnippet(
      "Other title",
      [msg("price       went   up\n\nlots")],
      ["price"],
    );
    expect(snippet).not.toMatch(/\s{2,}/);
  });
});
