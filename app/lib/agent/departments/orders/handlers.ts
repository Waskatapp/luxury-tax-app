// V-Or-A — Orders department handlers. Reads thread the per-conversation
// cache (5-min TTL). Writes are pass-through wrappers; snapshotBefore +
// readCacheInvalidate wiring lives in executor.server.ts.
//
// V-Or-B — Note + tag writes (update_order_note, update_order_tags).
// Both target orderUpdate; admin-only metadata (customer never sees the
// note; tags are internal organization). Lowest-risk writes in Orders.
//
// V-Or-C — Fulfillment writes (mark_as_fulfilled, fulfill_order_with_tracking).
// Both target fulfillmentCreateV2 — they SEND THE CUSTOMER A SHIPPING-
// CONFIRMATION EMAIL unless notifyCustomer:false. Medium-risk because
// the customer sees the result; the FunctionDeclaration descriptions
// and the manager prompt surface this.

import {
  fulfillOrderWithTracking,
  markAsFulfilled,
  readOrderDetail,
  readOrders,
  updateOrderNote,
  updateOrderTags,
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

export const updateOrderNoteHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateOrderNote(ctx.admin, input);
};

export const updateOrderTagsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateOrderTags(ctx.admin, input);
};

export const markAsFulfilledHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return markAsFulfilled(ctx.admin, input);
};

export const fulfillOrderWithTrackingHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return fulfillOrderWithTracking(ctx.admin, input);
};
