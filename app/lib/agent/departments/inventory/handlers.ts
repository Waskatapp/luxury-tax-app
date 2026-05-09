// V-Inv-A — Inventory & Operations department handlers. Reads thread
// the per-conversation cache (5-min TTL); the lone Round A write
// (set_inventory_tracking) is a pass-through wrapper. snapshotBefore +
// readCacheInvalidate wiring lives in executor.server.ts.
//
// Round B (quantity mutations: adjust / set / transfer) appends three
// more pass-through write handlers here.

import {
  adjustInventoryQuantity,
  readInventoryLevels,
  readLocations,
  setInventoryQuantity,
  setInventoryTracking,
  transferInventory,
} from "../../../shopify/inventory.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
import type { HandlerContext, ToolHandler } from "../department-spec";

export const readLocationsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_locations", input);
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readLocations(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_locations", input, result.data);
  }
  return result;
};

export const readInventoryLevelsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(
      ctx.conversationId,
      "read_inventory_levels",
      input,
    );
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readInventoryLevels(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(
      ctx.conversationId,
      "read_inventory_levels",
      input,
      result.data,
    );
  }
  return result;
};

export const setInventoryTrackingHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return setInventoryTracking(ctx.admin, input);
};

// V-Inv-B — Quantity-mutating writes. All three are pass-through wrappers
// (the underlying functions handle Zod, defensive gates, and the Shopify
// mutation). snapshotBefore + readCacheInvalidate wiring lives in
// executor.server.ts; the snapshot helper (fetchInventoryLevels) is
// shared across all four inventory writes.

export const adjustInventoryQuantityHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return adjustInventoryQuantity(ctx.admin, input);
};

export const setInventoryQuantityHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return setInventoryQuantity(ctx.admin, input);
};

export const transferInventoryHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return transferInventory(ctx.admin, input);
};
