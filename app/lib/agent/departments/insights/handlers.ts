import { getAnalytics } from "../../../shopify/analytics.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
import type {
  HandlerContext,
  ToolHandler,
} from "../department-spec";

// V-Sub-2 — Phase Sub-Agents Insights department handlers. Thin wrappers
// over the existing Shopify analytics functions in
// app/lib/shopify/analytics.server.ts. The underlying functions are
// untouched — this module just adapts them to the ToolHandler shape and
// preserves the read-cache integration that previously lived in
// executor.server.ts.

// get_analytics handler. Reads sales/inventory metrics; cached per-
// conversation for 5 minutes (read-cache.server.ts) so repeated turns
// in one conversation don't re-fetch the same data.
//
// Same cache integration as the legacy executor case at
// executor.server.ts:143-149 prior to migration. The cache key includes
// the input shape so different metrics/windows are cached separately.
export const getAnalyticsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  // Cache hit path. Same idempotent shape as the central executor's
  // CACHEABLE_READ_TOOLS check.
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "get_analytics", input);
    if (cached !== undefined) {
      return { ok: true, data: cached };
    }
  }

  const result = await getAnalytics(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "get_analytics", input, result.data);
  }
  return result;
};
