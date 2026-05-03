// V-Or-A — Orders department handlers. Round A is read-only — both reads
// thread the per-conversation cache (5-min TTL). Writes added in Or-B/C/D
// will be pass-through wrappers; snapshotBefore + readCacheInvalidate
// wiring lives in executor.server.ts.

import {
  readOrderDetail,
  readOrders,
} from "../../../shopify/orders.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
import type { HandlerContext, ToolHandler } from "../department-spec";

export const readOrdersHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_orders", input);
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readOrders(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_orders", input, result.data);
  }
  return result;
};

export const readOrderDetailHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_order_detail", input);
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readOrderDetail(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(
      ctx.conversationId,
      "read_order_detail",
      input,
      result.data,
    );
  }
  return result;
};
