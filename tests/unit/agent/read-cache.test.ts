import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _testing,
  readCacheClearConversation,
  readCacheGet,
  readCacheInvalidate,
  readCacheSet,
} from "../../../app/lib/agent/read-cache.server";

afterEach(() => {
  _testing.reset();
  vi.useRealTimers();
});

const CONV = "conv_1";
const TOOL = "read_products";

describe("readCacheGet / readCacheSet", () => {
  it("returns undefined on miss", () => {
    expect(readCacheGet(CONV, TOOL, { query: "foo" })).toBeUndefined();
  });

  it("round-trips a hit", () => {
    readCacheSet(CONV, TOOL, { query: "foo" }, { products: [1, 2, 3] });
    expect(readCacheGet(CONV, TOOL, { query: "foo" })).toEqual({
      products: [1, 2, 3],
    });
  });

  it("treats argument shape as canonical (key order doesn't matter)", () => {
    readCacheSet(CONV, TOOL, { query: "foo", first: 20 }, "data");
    expect(readCacheGet(CONV, TOOL, { first: 20, query: "foo" })).toBe("data");
  });

  it("different args = different keys", () => {
    readCacheSet(CONV, TOOL, { query: "foo" }, "A");
    readCacheSet(CONV, TOOL, { query: "bar" }, "B");
    expect(readCacheGet(CONV, TOOL, { query: "foo" })).toBe("A");
    expect(readCacheGet(CONV, TOOL, { query: "bar" })).toBe("B");
  });

  it("different conversations = isolated caches", () => {
    readCacheSet("conv_a", TOOL, {}, "for_a");
    readCacheSet("conv_b", TOOL, {}, "for_b");
    expect(readCacheGet("conv_a", TOOL, {})).toBe("for_a");
    expect(readCacheGet("conv_b", TOOL, {})).toBe("for_b");
  });

  it("uncacheable tool name is ignored on set/get", () => {
    readCacheSet(CONV, "update_product_price", {}, "data");
    expect(readCacheGet(CONV, "update_product_price", {})).toBeUndefined();
    expect(_testing.size()).toBe(0);
  });
});

describe("TTL expiration", () => {
  it("returns undefined after TTL elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00Z"));
    readCacheSet(CONV, TOOL, {}, "data");
    expect(readCacheGet(CONV, TOOL, {})).toBe("data");

    vi.setSystemTime(new Date(Date.now() + _testing.TTL_MS + 1));
    expect(readCacheGet(CONV, TOOL, {})).toBeUndefined();
  });

  it("entry just under TTL still hits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00Z"));
    readCacheSet(CONV, TOOL, {}, "data");
    vi.setSystemTime(new Date(Date.now() + _testing.TTL_MS - 1));
    expect(readCacheGet(CONV, TOOL, {})).toBe("data");
  });
});

describe("LRU eviction", () => {
  it("evicts oldest when cap exceeded", () => {
    // Set MAX_PER_CONVERSATION + 1 entries with distinct keys.
    const cap = _testing.MAX_PER_CONVERSATION;
    for (let i = 0; i <= cap; i++) {
      readCacheSet(CONV, TOOL, { i }, `data-${i}`);
    }
    // The very first entry should be evicted.
    expect(readCacheGet(CONV, TOOL, { i: 0 })).toBeUndefined();
    // The newest entry should still be there.
    expect(readCacheGet(CONV, TOOL, { i: cap })).toBe(`data-${cap}`);
  });

  it("hit bumps LRU order so the entry is no longer the oldest", () => {
    const cap = _testing.MAX_PER_CONVERSATION;
    for (let i = 0; i < cap; i++) {
      readCacheSet(CONV, TOOL, { i }, `data-${i}`);
    }
    // Touch the first entry to bump it.
    expect(readCacheGet(CONV, TOOL, { i: 0 })).toBe("data-0");
    // Add one more — that should evict entry 1, not entry 0.
    readCacheSet(CONV, TOOL, { i: cap }, `data-${cap}`);
    expect(readCacheGet(CONV, TOOL, { i: 0 })).toBe("data-0");
    expect(readCacheGet(CONV, TOOL, { i: 1 })).toBeUndefined();
  });
});

describe("readCacheInvalidate", () => {
  it("drops only entries matching the given tool prefixes", () => {
    readCacheSet(CONV, "read_products", {}, "P");
    readCacheSet(CONV, "read_collections", {}, "C");
    readCacheSet(CONV, "get_analytics", {}, "A");

    readCacheInvalidate(CONV, ["read_products", "read_collections"]);

    expect(readCacheGet(CONV, "read_products", {})).toBeUndefined();
    expect(readCacheGet(CONV, "read_collections", {})).toBeUndefined();
    expect(readCacheGet(CONV, "get_analytics", {})).toBe("A");
  });

  it("null toolNames clears the entire conversation", () => {
    readCacheSet(CONV, "read_products", {}, "P");
    readCacheSet(CONV, "get_analytics", {}, "A");
    readCacheInvalidate(CONV, null);
    expect(readCacheGet(CONV, "read_products", {})).toBeUndefined();
    expect(readCacheGet(CONV, "get_analytics", {})).toBeUndefined();
  });

  it("doesn't touch other conversations", () => {
    readCacheSet("conv_a", "read_products", {}, "A");
    readCacheSet("conv_b", "read_products", {}, "B");
    readCacheInvalidate("conv_a", null);
    expect(readCacheGet("conv_b", "read_products", {})).toBe("B");
  });
});

describe("readCacheClearConversation", () => {
  it("removes the entire conversation map", () => {
    readCacheSet(CONV, "read_products", {}, "data");
    expect(_testing.size()).toBe(1);
    readCacheClearConversation(CONV);
    expect(_testing.size()).toBe(0);
  });

  it("no-ops on unknown conversations", () => {
    expect(() => readCacheClearConversation("nope")).not.toThrow();
  });
});
