// V2.4 — per-conversation in-memory cache for read-tool results. Two
// independent benefits:
//   1. Skips redundant Shopify GraphQL calls (saves rate-limit budget).
//   2. Smaller Gemini history = less prompt-token cost on the next turn,
//      since cached tool_result bodies are still small but not zero.
//
// Single-process Map is correct for Railway today (one replica). If we
// ever scale horizontally we'd swap this for Redis without changing the
// callers — same get/set/invalidate signatures (see CLAUDE.md
// "Phase 7 wrapper note" for the precedent).
//
// Cache shape: Map<conversationId, Map<cacheKey, CachedResult>>. The
// outer map is per-tenant-conversation so cleanup-on-conversation-delete
// is one delete; the inner map is LRU-ordered by insertion (Map iteration
// order is insertion order in JS, and we re-set on hits to bump).

const TTL_MS = 5 * 60 * 1_000; // 5 minutes
const MAX_PER_CONVERSATION = 100;

// Tools whose results are worth caching. Read tools only; we never cache
// write-tool results (they're side-effecting and the result includes
// freshly-mutated state we want to round-trip exactly once).
export const CACHEABLE_READ_TOOLS = new Set<string>([
  "read_products",
  "read_collections",
  "get_analytics",
  // V2.5a — read_workflow reads from the in-memory parsed-workflows
  // cache, so the work itself is already O(1). We still cache here so
  // the same workflow body in conversation history doesn't re-bloat
  // Gemini token cost across re-prompts within the 5-min TTL.
  "read_workflow",
  // V-PP-A — Pricing & Promotions read tool. Discount listings rarely
  // change within a 5-min window; caching saves a Shopify roundtrip
  // when the CEO chains read_discounts → update_discount in the same
  // conversation. Invalidated on any discount-write (Round PP-B+).
  "read_discounts",
  // V-IN-A — Insights deepening. Both wrap getProductWindowAnalytics
  // (which scans up to 1000 orders); caching dramatically helps the
  // common "drill in" pattern where the merchant asks the same
  // product/period question multiple ways within a conversation.
  "get_product_performance",
  "compare_periods",
  // V-IN-B — get_top_performers. Scans up to 200 orders per call;
  // caching helps when the merchant asks "top sellers" then "wait,
  // sort by revenue" (different cache key, separate scan, but each
  // is cached for follow-up drills).
  "get_top_performers",
  // V-Mkt-B — read_articles. Caches the article-list result; busted
  // on any article write. Pattern matches read_products / read_collections.
  "read_articles",
  // V-Mkt-C — read_pages. Same caching rationale as read_articles.
  "read_pages",
  // V-Cu-A — Customers reads. read_customer_detail is the heavy one
  // (single GraphQL roundtrip including consent state + recent orders +
  // default address); caching it across the conversation matters for
  // the common "tell me about X" → "what about Y" → "back to X" flow.
  "read_customers",
  "read_customer_detail",
  // V-Cu-B — Customer segments (read-only). Cache because segment
  // composition rarely changes within a 5-min conversation window.
  "read_segments",
  "read_segment_members",
]);

type CachedResult = {
  data: unknown;
  ts: number; // ms since epoch
};

const cache: Map<string, Map<string, CachedResult>> = new Map();

// Stable serialization so semantically-identical args produce the same
// key. Object keys sorted; arrays/primitives passthrough. We only handle
// the shapes our read tools actually use (small objects of strings,
// numbers, booleans) — no need for full deep-canonicalization.
function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k]));
  return "{" + parts.join(",") + "}";
}

function cacheKey(toolName: string, args: unknown): string {
  return toolName + ":" + canonical(args);
}

// Returns the cached `data` if a non-expired hit exists, else undefined.
// Bumps LRU order on hit (re-set so the entry moves to the end).
export function readCacheGet(
  conversationId: string,
  toolName: string,
  args: unknown,
): unknown | undefined {
  if (!CACHEABLE_READ_TOOLS.has(toolName)) return undefined;
  const conv = cache.get(conversationId);
  if (!conv) return undefined;
  const key = cacheKey(toolName, args);
  const entry = conv.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TTL_MS) {
    conv.delete(key);
    return undefined;
  }
  // LRU bump: re-set moves the entry to the end of the iteration order.
  conv.delete(key);
  conv.set(key, entry);
  return entry.data;
}

export function readCacheSet(
  conversationId: string,
  toolName: string,
  args: unknown,
  data: unknown,
): void {
  if (!CACHEABLE_READ_TOOLS.has(toolName)) return;
  let conv = cache.get(conversationId);
  if (!conv) {
    conv = new Map();
    cache.set(conversationId, conv);
  }
  const key = cacheKey(toolName, args);
  conv.set(key, { data, ts: Date.now() });
  // LRU evict the oldest entries until we're at the cap.
  while (conv.size > MAX_PER_CONVERSATION) {
    const oldestKey = conv.keys().next().value;
    if (oldestKey === undefined) break;
    conv.delete(oldestKey);
  }
}

// Coarse invalidation: drop entries whose key starts with any of the
// given tool name prefixes. Pass `null` to drop the entire conversation.
//
// Called from executeApprovedWrite after a Shopify mutation succeeds
// because the merchant has just changed the underlying state — any
// cached read for that conversation is potentially stale. The 5-min
// TTL would catch this eventually, but cache-on-stale-write is worse
// UX (CEO confidently quotes the OLD price right after approving the
// NEW one).
export function readCacheInvalidate(
  conversationId: string,
  toolNames: string[] | null,
): void {
  if (toolNames === null) {
    cache.delete(conversationId);
    return;
  }
  const conv = cache.get(conversationId);
  if (!conv) return;
  const prefixes = toolNames.map((n) => n + ":");
  // Snapshot keys before mutating during iteration.
  const keys = Array.from(conv.keys());
  for (const key of keys) {
    if (prefixes.some((p) => key.startsWith(p))) {
      conv.delete(key);
    }
  }
}

// Drop a whole conversation's cache. Called when a Conversation row is
// deleted (api.conversations DELETE) so abandoned process memory doesn't
// pile up. Also useful for tests.
export function readCacheClearConversation(conversationId: string): void {
  cache.delete(conversationId);
}

// ---- Test seams ----

export const _testing = {
  TTL_MS,
  MAX_PER_CONVERSATION,
  cacheKey,
  reset(): void {
    cache.clear();
  },
  size(): number {
    let total = 0;
    for (const conv of cache.values()) total += conv.size;
    return total;
  },
};
