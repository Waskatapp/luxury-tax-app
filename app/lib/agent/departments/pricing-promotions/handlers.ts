import {
  bulkUpdatePrices,
  updateCompareAtPrice,
  updateProductPrice,
} from "../../../shopify/pricing.server";
import {
  createDiscount,
  deleteDiscount,
  readDiscounts,
  setDiscountStatus,
  updateDiscount,
} from "../../../shopify/discounts.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
import type {
  HandlerContext,
  ToolHandler,
} from "../department-spec";

// V-Sub-4 — Phase Sub-Agents Pricing & Promotions handlers. Thin
// wrappers over the existing Shopify pricing + discounts modules
// (UNTOUCHED). Both tools are WRITE — neither runs at sub-agent time;
// they're collected as ProposedWrite, queued as PendingAction, and
// executed by executeApprovedWrite (registry-dispatched) after merchant
// approval.
//
// V-PP-A — added 3 tools (Round PP-A): updateCompareAtPrice, bulkUpdatePrices
// (writes — pass-through), and readDiscounts (read — caches via the
// per-conversation read cache for cheap re-reads).

// ----- READ handlers -----

export const readDiscountsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_discounts", input);
    if (cached !== undefined) {
      return { ok: true, data: cached };
    }
  }
  const result = await readDiscounts(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_discounts", input, result.data);
  }
  return result;
};

// ----- WRITE handlers (called by executeApprovedWrite post-approval) -----

export const updateProductPriceHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductPrice(ctx.admin, input);
};

export const updateCompareAtPriceHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateCompareAtPrice(ctx.admin, input);
};

export const bulkUpdatePricesHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return bulkUpdatePrices(ctx.admin, input);
};

export const createDiscountHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return createDiscount(ctx.admin, input);
};

export const updateDiscountHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateDiscount(ctx.admin, input);
};

export const setDiscountStatusHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return setDiscountStatus(ctx.admin, input);
};

export const deleteDiscountHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return deleteDiscount(ctx.admin, input);
};
