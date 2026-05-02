// V-Mkt-A — Marketing department handlers. Thin wrappers over the SEO
// functions in app/lib/shopify/seo.server.ts. Both tools are
// approval-gated writes — the handler is invoked from
// executeApprovedWrite AFTER the merchant approves the ApprovalCard, so
// no Zod validation lives here (the underlying seo.server.ts function
// validates), and there's no read-cache integration (writes don't read
// from the cache; they bust it on success — coarse invalidation lives in
// executor.server.ts).
//
// V-Mkt-B — Blog articles added. read_articles is the dept's first read
// tool; threads the per-conversation cache the same way the Insights
// reads do.

import {
  createArticle,
  deleteArticle,
  readArticles,
  updateArticle,
} from "../../../shopify/articles.server";
import {
  updateCollectionSeo,
  updateProductSeo,
} from "../../../shopify/seo.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
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

// V-Mkt-B — read_articles handler. Cached per-conversation for 5 minutes
// so a "list my blog posts" → "tell me more about that one" follow-up
// doesn't re-scan articles. Cache is busted on any article write (see
// readCacheInvalidate list in executor.server.ts).
export const readArticlesHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_articles", input);
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readArticles(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_articles", input, result.data);
  }
  return result;
};

export const createArticleHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return createArticle(ctx.admin, input);
};

export const updateArticleHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateArticle(ctx.admin, input);
};

export const deleteArticleHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return deleteArticle(ctx.admin, input);
};
