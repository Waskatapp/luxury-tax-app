import {
  createProductDraft,
  duplicateProduct,
  readProducts,
  updateProductDescription,
  updateProductStatus,
  updateProductTags,
  updateProductTitle,
  updateProductType,
  updateProductVendor,
  updateVariant,
} from "../../../shopify/products.server";
import { readCollections } from "../../../shopify/collections.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
import type {
  HandlerContext,
  ToolHandler,
} from "../department-spec";

// V-Sub-3 — Phase Sub-Agents Products department handlers. Thin wrappers
// over the existing Shopify modules in:
//   - app/lib/shopify/products.server.ts (5 functions touching products)
//   - app/lib/shopify/collections.server.ts (1 function for collections)
//
// Underlying modules are UNTOUCHED. This handlers module only adapts
// them to the ToolHandler shape and threads the read-cache integration
// that previously lived in executor.server.ts.
//
// READ handlers (read_products, read_collections) execute inline during
// the sub-agent's turn — same caching semantics as before migration:
// 5-min TTL per conversation, populated on first call, returned on
// subsequent calls within the window.
//
// WRITE handlers (update_product_description, update_product_status,
// create_product_draft) are NOT executed by the sub-agent. The
// dispatcher collects them as ProposedWrite[] and bubbles up to
// api.chat.tsx, which queues them as PendingActions. After merchant
// approval, executeApprovedWrite (registry-dispatched) invokes the
// handler with the post-approval ctx (conversationId for cache
// invalidation, etc.).

// ----- READ handlers -----

export const readProductsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_products", input);
    if (cached !== undefined) {
      return { ok: true, data: cached };
    }
  }
  const result = await readProducts(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_products", input, result.data);
  }
  return result;
};

export const readCollectionsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_collections", input);
    if (cached !== undefined) {
      return { ok: true, data: cached };
    }
  }
  const result = await readCollections(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_collections", input, result.data);
  }
  return result;
};

// ----- WRITE handlers (called by executeApprovedWrite post-approval) -----

export const updateProductDescriptionHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductDescription(ctx.admin, input);
};

export const updateProductStatusHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductStatus(ctx.admin, input);
};

export const createProductDraftHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return createProductDraft(ctx.admin, input);
};

export const updateProductTitleHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductTitle(ctx.admin, input);
};

export const updateProductTagsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductTags(ctx.admin, input);
};

export const updateProductVendorHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductVendor(ctx.admin, input);
};

export const updateProductTypeHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductType(ctx.admin, input);
};

export const updateVariantHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateVariant(ctx.admin, input);
};

export const duplicateProductHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return duplicateProduct(ctx.admin, input);
};
