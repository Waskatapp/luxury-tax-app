import { describe, expect, it } from "vitest";

import {
  extractPrices,
  findHallucinations,
  isPriceGrounded,
} from "../../../app/lib/agent/hallucination-detector.server";

describe("extractPrices", () => {
  it("matches the dollar-sign price form", () => {
    expect(extractPrices("Set price to $19.99")).toEqual(["$19.99"]);
  });

  it("matches integer-only prices", () => {
    expect(extractPrices("Price is $20")).toEqual(["$20"]);
  });

  it("matches one-decimal prices", () => {
    expect(extractPrices("Price is $20.5")).toEqual(["$20.5"]);
  });

  it("matches prices with thousands separators", () => {
    expect(extractPrices("Set to $1,234.56")).toEqual(["$1,234.56"]);
  });

  it("tolerates a space between $ and the number", () => {
    expect(extractPrices("Set to $ 19.99")).toEqual(["$ 19.99"]);
  });

  it("de-duplicates by normalized form", () => {
    const out = extractPrices("Was $19.99 → now $19.99 (still $19.99).");
    expect(out).toEqual(["$19.99"]);
  });

  it("treats $19.99 and $1999 as different (no normalization across magnitude)", () => {
    const out = extractPrices("Was $19.99 → now $1999");
    expect(out).toHaveLength(2);
  });

  it("returns [] for text with no prices", () => {
    expect(extractPrices("The product is now active.")).toEqual([]);
  });

  it("returns [] for empty text", () => {
    expect(extractPrices("")).toEqual([]);
  });

  it("ignores a bare number with no $ prefix (avoid false-positives on inventory counts, percentages)", () => {
    expect(extractPrices("Stock: 19.99")).toEqual([]);
    expect(extractPrices("Lift conversion 12.5%")).toEqual([]);
  });
});

describe("isPriceGrounded", () => {
  it("matches when the grounding contains the same dollar-form", () => {
    expect(isPriceGrounded("$19.99", ["The price is $19.99 USD"])).toBe(true);
  });

  it("matches when the grounding contains the bare number form", () => {
    expect(isPriceGrounded("$19.99", ['{"price":"19.99","currencyCode":"USD"}'])).toBe(true);
  });

  it("matches when the grounding has the number with currency suffix", () => {
    expect(isPriceGrounded("$19.99", ["19.99 USD"])).toBe(true);
  });

  it("matches across thousands-separator differences ($1,234.56 vs 1234.56)", () => {
    expect(isPriceGrounded("$1,234.56", ['{"price":"1234.56"}'])).toBe(true);
  });

  it("returns false when the price is genuinely absent from grounding", () => {
    expect(isPriceGrounded("$19.99", ["The price is $24.99 USD"])).toBe(false);
  });

  it("returns false when grounding is empty", () => {
    expect(isPriceGrounded("$19.99", [])).toBe(false);
    expect(isPriceGrounded("$19.99", [""])).toBe(false);
  });

  it("works across multiple grounding strings (any-of)", () => {
    expect(
      isPriceGrounded("$19.99", [
        "Some unrelated tool result text",
        '{"variantId":"x","price":"19.99"}',
      ]),
    ).toBe(true);
  });

  it("treats integer prices as grounded against decimal forms when integer matches whole", () => {
    // "$20" should match grounding "20" (e.g., merchant said "set to $20")
    expect(isPriceGrounded("$20", ["set price to 20 USD"])).toBe(true);
  });
});

describe("findHallucinations", () => {
  it("returns empty unverifiedPrices when all prices are grounded", () => {
    const r = findHallucinations({
      responseText: "**Cat Food** is now $19.99 (was $24.99).",
      groundingTexts: [
        '{"productId":"x","oldPrice":"24.99","newPrice":"19.99"}',
      ],
    });
    expect(r.unverifiedPrices).toEqual([]);
  });

  it("flags a price the response makes up", () => {
    const r = findHallucinations({
      responseText: "**Cat Food** is now $14.99.",
      groundingTexts: [
        '{"productId":"x","oldPrice":"24.99","newPrice":"19.99"}',
      ],
    });
    expect(r.unverifiedPrices).toEqual(["$14.99"]);
  });

  it("returns empty when the response has no prices at all", () => {
    const r = findHallucinations({
      responseText: "I've drafted a description for cat food.",
      groundingTexts: ["any tool result"],
    });
    expect(r.unverifiedPrices).toEqual([]);
  });

  it("treats the merchant's own message as grounding (avoids false-positive on user-stated prices)", () => {
    // Merchant said "set price to $100"; CEO acknowledges "Setting to $100".
    // That's not a hallucination — it's a quote.
    const r = findHallucinations({
      responseText: "Setting to $100 — confirm?",
      groundingTexts: ["change the price of The Collection Snowboard to $100"],
    });
    expect(r.unverifiedPrices).toEqual([]);
  });

  it("flags multiple unverified prices independently", () => {
    const r = findHallucinations({
      responseText: "Was $24.99 → now $14.99. Also setting **Dog Food** to $9.99.",
      groundingTexts: [
        '{"productId":"x","oldPrice":"24.99","newPrice":"19.99"}',
      ],
    });
    expect(r.unverifiedPrices).toContain("$14.99");
    expect(r.unverifiedPrices).toContain("$9.99");
    expect(r.unverifiedPrices).not.toContain("$24.99");
  });

  it("returns empty for empty response and grounding", () => {
    const r = findHallucinations({ responseText: "", groundingTexts: [] });
    expect(r.unverifiedPrices).toEqual([]);
  });
});
