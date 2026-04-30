// V6.5 — Phase 6 Hallucination Guard. Pure helpers for detecting
// product-fact hallucinations in CEO responses. The CEO sometimes
// confidently quotes a price/inventory number it never actually fetched
// — usually a residual from earlier in the conversation that no longer
// reflects current state, or just a model fabrication.
//
// Detection strategy (intentionally conservative for v1):
//   1. Extract price-shaped numbers from the assistant response.
//   2. Check if each extracted number appears in the GROUNDING set —
//      the union of (a) this turn's tool_result content and (b) the
//      merchant's user message text (the merchant repeating "$100"
//      isn't a hallucination, it's a quote).
//   3. Anything in the response that's NOT in the grounding set is a
//      candidate hallucination — logged for visibility, NOT (in v1)
//      promoted to a TurnSignal outcome. False-positive rate has to
//      be observed in production before we wire it as a hard signal.
//
// Inventory / SKU detection is out of scope for v1 — too noisy.

// Matches:
//   $19, $19.99, $19.9, $1,234.56, $ 19.99 (with space)
// Capture group 1 is the numeric portion (no $ sign).
// We don't match negative or scientific notation — not realistic for
// product prices in chat.
const PRICE_REGEX = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;

// Normalizes "1,234.56" → "1234.56", "19,9" (Euro) → "19.9", "19.99" → "19.99".
// Used to compare against grounding text where the same number might be
// written differently (e.g., tool result has "19.99 USD" and response
// has "$19.99").
function normalizePrice(raw: string): string {
  // Strip $, whitespace.
  const stripped = raw.replace(/[$\s]/g, "");
  // If exactly one comma and no dot, treat the comma as decimal (Euro).
  if (stripped.indexOf(",") !== -1 && stripped.indexOf(".") === -1) {
    const lastComma = stripped.lastIndexOf(",");
    const tail = stripped.slice(lastComma + 1);
    if (tail.length === 1 || tail.length === 2) {
      return stripped.slice(0, lastComma).replace(/,/g, "") + "." + tail;
    }
  }
  // Otherwise, commas are thousands separators; drop them.
  return stripped.replace(/,/g, "");
}

// Extract every distinct price-shaped string from a text. De-duplicated
// by normalized form. Returns the original-form strings so the log
// message reads naturally ("$19.99 — not in tool results").
export function extractPrices(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of text.matchAll(PRICE_REGEX)) {
    const original = m[0].trim();
    const norm = normalizePrice(original);
    if (norm.length === 0) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(original);
  }
  return result;
}

// Determines whether `priceText` (e.g., "$19.99") is grounded in any
// of the provided grounding strings. Comparison is on the normalized
// numeric form, so "$19.99" matches "19.99 USD" matches "19,99" (Euro).
export function isPriceGrounded(
  priceText: string,
  groundingTexts: string[],
): boolean {
  const target = normalizePrice(priceText);
  if (target.length === 0) return true; // pathological — don't false-positive
  // Re-extract numeric tokens from each grounding string and compare
  // by normalized form. We deliberately do NOT use a substring
  // `g.includes(target)` shortcut — that produces false negatives like
  // "$19.99".includes("9.99") which would silently mask a real
  // hallucination of "$9.99".
  const bareRegex = /[\d,]+(?:\.\d{1,2})?/g;
  for (const g of groundingTexts) {
    if (!g) continue;
    // Try the explicit price form first ($-prefixed) — slightly tighter.
    for (const m of g.matchAll(PRICE_REGEX)) {
      if (normalizePrice(m[0]) === target) return true;
    }
    // Then the bare numeric form (catches "price: 19.99" in JSON tool
    // results, "set price to 19.99" in user text, etc.). Still strict
    // by-token: each match's normalized form must equal target exactly.
    for (const m of g.matchAll(bareRegex)) {
      if (normalizePrice(m[0]) === target) return true;
    }
  }
  return false;
}

export type HallucinationFinding = {
  unverifiedPrices: string[];
};

// Main entry. Returns the prices that appear in `responseText` but are
// not grounded in any of `groundingTexts`. Empty array means "all
// claims are grounded" (or no price claims were made at all).
export function findHallucinations(opts: {
  responseText: string;
  groundingTexts: string[];
}): HallucinationFinding {
  const prices = extractPrices(opts.responseText);
  if (prices.length === 0) {
    return { unverifiedPrices: [] };
  }
  const unverified: string[] = [];
  for (const p of prices) {
    if (!isPriceGrounded(p, opts.groundingTexts)) {
      unverified.push(p);
    }
  }
  return { unverifiedPrices: unverified };
}
