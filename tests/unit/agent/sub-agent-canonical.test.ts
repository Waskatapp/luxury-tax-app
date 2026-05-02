import { describe, expect, it } from "vitest";

import { _testing } from "../../../app/lib/agent/sub-agent.server";

const { canonicalArgs } = _testing;

// V-Mkt-B fix — these tests lock in the dedup behavior we added to the
// sub-agent loop. The bug we caught in chat: Marketing manager emitted
// two delete_article calls with identical args; both got queued; second
// failed because the first deletion already succeeded. Dedup hinges on
// canonicalArgs producing the same string for semantically-identical
// inputs.

describe("sub-agent canonicalArgs", () => {
  it("identical objects produce identical keys", () => {
    const a = { articleId: "gid://shopify/Article/1", confirmTitle: "Cat Tips" };
    const b = { articleId: "gid://shopify/Article/1", confirmTitle: "Cat Tips" };
    expect(canonicalArgs(a)).toBe(canonicalArgs(b));
  });

  it("different key order produces identical keys (sorted internally)", () => {
    // Gemini sometimes emits tool_use blocks with stable key order, but
    // we don't want to rely on that — the bug guard must work even if
    // the model swaps key order between two tool_use blocks.
    const a = { articleId: "gid://1", confirmTitle: "Cat Tips" };
    const b = { confirmTitle: "Cat Tips", articleId: "gid://1" };
    expect(canonicalArgs(a)).toBe(canonicalArgs(b));
  });

  it("different values produce different keys (no false positive dedup)", () => {
    const a = { articleId: "gid://shopify/Article/1" };
    const b = { articleId: "gid://shopify/Article/2" };
    expect(canonicalArgs(a)).not.toBe(canonicalArgs(b));
  });

  it("nested objects sorted recursively", () => {
    const a = {
      product: { id: "gid://1", seo: { title: "T", description: "D" } },
    };
    const b = {
      product: { seo: { description: "D", title: "T" }, id: "gid://1" },
    };
    expect(canonicalArgs(a)).toBe(canonicalArgs(b));
  });

  it("arrays preserved in order (positional, not sorted)", () => {
    // Tags ["a", "b"] is semantically different from ["b", "a"] for
    // some Shopify mutations (replacement-set semantics), so arrays
    // are NOT sorted — only object keys are.
    const a = { tags: ["a", "b"] };
    const b = { tags: ["b", "a"] };
    expect(canonicalArgs(a)).not.toBe(canonicalArgs(b));
  });

  it("null and undefined collapse to the same string", () => {
    expect(canonicalArgs(null)).toBe(canonicalArgs(undefined));
    expect(canonicalArgs(null)).toBe("null");
  });

  it("primitives serialize via JSON.stringify", () => {
    expect(canonicalArgs("hello")).toBe('"hello"');
    expect(canonicalArgs(42)).toBe("42");
    expect(canonicalArgs(true)).toBe("true");
  });

  it("empty object is deterministic", () => {
    expect(canonicalArgs({})).toBe("{}");
  });
});
