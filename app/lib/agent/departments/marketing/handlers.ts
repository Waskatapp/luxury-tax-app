// V-Mkt-A — Marketing department handlers. Thin wrappers over the SEO
// functions in app/lib/shopify/seo.server.ts. Both tools are
// approval-gated writes — the handler is invoked from
// executeApprovedWrite AFTER the merchant approves the ApprovalCard, so
// no Zod validation lives here (the underlying seo.server.ts function
// validates), and there's no read-cache integration (writes don't read
// from the cache; they bust it on success — coarse invalidation lives in
// executor.server.ts).

import {
  updateCollectionSeo,
  updateProductSeo,
} from "../../../shopify/seo.server";
import type { HandlerContext, ToolHandler } from "../department-spec";

export const updateProductSeoHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateProductSeo(ctx.admin, input);
};

export const updateCollectionSeoHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateCollectionSeo(ctx.admin, input);
};
