import { updateProductPrice } from "../../../shopify/pricing.server";
import { createDiscount } from "../../../shopify/discounts.server";
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

export const updateProductPriceHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductPrice(ctx.admin, input);
};

export const createDiscountHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return createDiscount(ctx.admin, input);
};
