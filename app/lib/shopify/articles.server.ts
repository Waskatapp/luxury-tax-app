// V-Mkt-B — Marketing department blog articles. Reads + writes for the
// store's blog posts. Articles live under "blogs" — most stores have one
// default blog (typically "News"); this module accepts an optional
// `blogId` and falls back to the first blog when not provided.
//
// Scopes required: read_content (read), write_content (mutations). Both
// added to shopify.app.toml in Round Mkt-B; the dev store must be
// re-installed before any of these calls succeed.
//
// Defensive pattern: deleteArticle requires a `confirmTitle` that must
// match the live article's title (case-insensitive trim) before the
// delete mutation is issued. Guards against an LLM hallucinating an
// articleId and accidentally deleting the wrong post. Without the gate,
// a typo'd GID with a real article on the other end would silently
// destroy unrelated content — same risk profile that justified the
// confirmation prompt on bulk price changes in P&P.

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Snapshot shapes
// ----------------------------------------------------------------------------

// Full article — used as the fetch snapshot, the create/update return shape,
// and the AuditLog before/after. List reads return ArticleSummary instead
// (omits body to keep payloads small).
export type ArticleSnapshot = {
  articleId: string;
  blogId: string;
  blogTitle: string;
  title: string;
  handle: string;
  body: string;
  summary: string | null;
  author: string | null;
  tags: string[];
  imageUrl: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

export type ArticleSummary = {
  articleId: string;
  blogId: string;
  blogTitle: string;
  title: string;
  handle: string;
  summary: string | null;
  author: string | null;
  tags: string[];
  imageUrl: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

export type ReadArticlesResult = {
  blogId: string | null; // null when listing across all blogs
  articles: ArticleSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type DeletedArticleResult = {
  deletedArticleId: string;
  title: string; // echoed back so the AuditLog after-state is human-readable
};

// ----------------------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------------------

const TITLE_MAX = 255;
const SUMMARY_MAX = 1000;
const TAGS_MAX = 250;

export const ReadArticlesInput = z.object({
  blogId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().optional(),
});

export const CreateArticleInput = z.object({
  // blogId optional — handler resolves to the first blog if absent. Most
  // stores have exactly one blog (the default "News"); a merchant who runs
  // multiple blogs should pass blogId explicitly.
  blogId: z.string().min(1).optional(),
  title: z.string().min(1).max(TITLE_MAX),
  body: z.string().min(1),
  summary: z.string().max(SUMMARY_MAX).optional(),
  author: z.string().max(255).optional(),
  tags: z.array(z.string().min(1).max(TAGS_MAX)).max(50).optional(),
  imageUrl: z.string().url().optional(),
  // Default false — published articles go LIVE on the storefront. Forcing
  // explicit opt-in for publication keeps the merchant in control. If they
  // want to publish, they pass true (or follow up with update_article).
  isPublished: z.boolean().default(false),
});

export const UpdateArticleInput = z
  .object({
    articleId: z.string().min(1),
    title: z.string().min(1).max(TITLE_MAX).optional(),
    body: z.string().min(1).optional(),
    summary: z.string().max(SUMMARY_MAX).optional(),
    author: z.string().max(255).optional(),
    tags: z.array(z.string().min(1).max(TAGS_MAX)).max(50).optional(),
    imageUrl: z.string().url().nullable().optional(), // null = clear image
    isPublished: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.summary !== undefined ||
      v.author !== undefined ||
      v.tags !== undefined ||
      v.imageUrl !== undefined ||
      v.isPublished !== undefined,
    { message: "must provide at least one field to update" },
  );

export const DeleteArticleInput = z.object({
  articleId: z.string().min(1),
  // Defensive gate: the manager passes the article's title alongside the
  // GID, the handler checks they match before issuing the delete. Empty
  // string is rejected so an LLM can't sidestep the gate by passing "".
  confirmTitle: z
    .string()
    .min(1)
    .max(TITLE_MAX)
    .trim()
    .refine((s) => s.length > 0, {
      message: "confirmTitle cannot be empty or whitespace-only",
    }),
});

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const BLOGS_FIRST_QUERY = `#graphql
  query Blogs($first: Int!) {
    blogs(first: $first) {
      edges { node { id title } }
    }
  }
`;

// V-Mkt-B fix — Shopify's ArticleCreateInput.author is AuthorInput!
// (required), so omitting the field fails GraphQL validation BEFORE the
// resolver runs. When the caller doesn't pass an author, we fall back to
// the shop owner's display name — matching the behavior of Shopify's
// admin UI when a store owner creates an article through the dashboard.
const SHOP_OWNER_QUERY = `#graphql
  query Shop {
    shop { name }
  }
`;

const FETCH_ARTICLE_QUERY = `#graphql
  query FetchArticle($id: ID!) {
    article(id: $id) {
      id
      title
      handle
      body
      summary
      author { name }
      tags
      image { url }
      isPublished
      publishedAt
      updatedAt
      blog { id title }
    }
  }
`;

const READ_ARTICLES_QUERY = `#graphql
  query ReadArticles($first: Int!, $after: String, $query: String) {
    articles(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          title
          handle
          summary
          author { name }
          tags
          image { url }
          isPublished
          publishedAt
          updatedAt
          blog { id title }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ARTICLE_CREATE_MUTATION = `#graphql
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        title
        handle
        body
        summary
        author { name }
        tags
        image { url }
        isPublished
        publishedAt
        updatedAt
        blog { id title }
      }
      userErrors { field message code }
    }
  }
`;

const ARTICLE_UPDATE_MUTATION = `#graphql
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        title
        handle
        body
        summary
        author { name }
        tags
        image { url }
        isPublished
        publishedAt
        updatedAt
        blog { id title }
      }
      userErrors { field message code }
    }
  }
`;

const ARTICLE_DELETE_MUTATION = `#graphql
  mutation ArticleDelete($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors { field message code }
    }
  }
`;

// ----------------------------------------------------------------------------
// GraphQL response types
// ----------------------------------------------------------------------------

type ArticleNode = {
  id: string;
  title: string;
  handle: string;
  body: string | null;
  summary: string | null;
  author: { name: string } | null;
  tags: string[];
  image: { url: string } | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
  blog: { id: string; title: string } | null;
};

// List-shape article — body omitted (`body: null` in the type but the
// query doesn't request it; we just default it to "" if a caller looks).
type ArticleListNode = Omit<ArticleNode, "body">;

type BlogsResponse = {
  blogs: { edges: Array<{ node: { id: string; title: string } }> };
};

type ShopResponse = {
  shop: { name: string };
};

type FetchArticleResponse = { article: ArticleNode | null };

type ReadArticlesResponse = {
  articles: {
    edges: Array<{ cursor: string; node: ArticleListNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type ArticleCreateResponse = {
  articleCreate: {
    article: ArticleNode | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

type ArticleUpdateResponse = {
  articleUpdate: {
    article: ArticleNode | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

type ArticleDeleteResponse = {
  articleDelete: {
    deletedArticleId: string | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

// ----------------------------------------------------------------------------
// Mappers
// ----------------------------------------------------------------------------

function nodeToSnapshot(node: ArticleNode): ArticleSnapshot {
  return {
    articleId: node.id,
    blogId: node.blog?.id ?? "",
    blogTitle: node.blog?.title ?? "",
    title: node.title,
    handle: node.handle,
    body: node.body ?? "",
    summary: node.summary,
    author: node.author?.name ?? null,
    tags: node.tags,
    imageUrl: node.image?.url ?? null,
    isPublished: node.isPublished,
    publishedAt: node.publishedAt,
    updatedAt: node.updatedAt,
  };
}

function nodeToSummary(node: ArticleListNode): ArticleSummary {
  return {
    articleId: node.id,
    blogId: node.blog?.id ?? "",
    blogTitle: node.blog?.title ?? "",
    title: node.title,
    handle: node.handle,
    summary: node.summary,
    author: node.author?.name ?? null,
    tags: node.tags,
    imageUrl: node.image?.url ?? null,
    isPublished: node.isPublished,
    publishedAt: node.publishedAt,
    updatedAt: node.updatedAt,
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Resolve the merchant's default blog id. Most stores have ONE blog (the
// auto-created "News" blog from Shopify setup). For multi-blog stores the
// merchant must pass blogId explicitly to create_article. We don't cache
// this across calls — blog ids change rarely but the per-store rate budget
// is generous and cache invalidation isn't worth the bug surface.
async function getDefaultBlogId(
  admin: ShopifyAdmin,
): Promise<ToolModuleResult<{ blogId: string; blogTitle: string }>> {
  const result = await graphqlRequest<BlogsResponse>(admin, BLOGS_FIRST_QUERY, {
    first: 1,
  });
  if (!result.ok) return { ok: false, error: result.error };
  const edge = result.data.blogs.edges[0];
  if (!edge) {
    return {
      ok: false,
      error:
        "store has no blogs — create one in Shopify admin (Online Store → Blog Posts → Manage blogs) before publishing articles",
    };
  }
  return {
    ok: true,
    data: { blogId: edge.node.id, blogTitle: edge.node.title },
  };
}

// Default author fallback. Shopify's ArticleCreateInput.author is required
// (`AuthorInput!`); if the caller didn't pass one we use the shop's display
// name (e.g. "MyStore") as a sensible default rather than failing the
// mutation. The merchant can always edit the author later via update_article.
async function getDefaultAuthorName(
  admin: ShopifyAdmin,
): Promise<ToolModuleResult<string>> {
  const result = await graphqlRequest<ShopResponse>(admin, SHOP_OWNER_QUERY);
  if (!result.ok) return { ok: false, error: result.error };
  const name = result.data.shop?.name?.trim();
  if (!name) {
    // Shouldn't happen — every Shopify store has a name — but fall back
    // gracefully rather than blowing up the merchant's article draft.
    return { ok: true, data: "Store" };
  }
  return { ok: true, data: name };
}

// ----------------------------------------------------------------------------
// fetchArticle — snapshot helper used by snapshotBefore() in
// executor.server.ts and by deleteArticle's defensive gate.
// ----------------------------------------------------------------------------

export async function fetchArticle(
  admin: ShopifyAdmin,
  articleId: string,
): Promise<ToolModuleResult<ArticleSnapshot>> {
  const result = await graphqlRequest<FetchArticleResponse>(
    admin,
    FETCH_ARTICLE_QUERY,
    { id: articleId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.article) {
    return { ok: false, error: `article not found: ${articleId}` };
  }
  return { ok: true, data: nodeToSnapshot(result.data.article) };
}

// ----------------------------------------------------------------------------
// readArticles
//
// Top-level `articles` query — returns articles across ALL blogs. To filter
// to a single blog, callers pass `blogId` and the handler appends a
// `blog_id:<numeric>` clause to the GraphQL query string. Shopify's search
// syntax for articles supports blog_id (numeric), title, author, tag, etc.
// ----------------------------------------------------------------------------

export async function readArticles(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadArticlesResult>> {
  const parsed = ReadArticlesInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Build the GraphQL search-syntax query. blogId filter takes precedence;
  // we extract the numeric id from the GID since Shopify's search expects
  // a bare numeric for blog_id lookups.
  let queryParts: string[] = [];
  if (parsed.data.blogId) {
    const numeric = parsed.data.blogId.split("/").pop() ?? parsed.data.blogId;
    queryParts.push(`blog_id:${numeric}`);
  }
  if (parsed.data.query) queryParts.push(parsed.data.query);
  const queryString = queryParts.length > 0 ? queryParts.join(" ") : null;

  const result = await graphqlRequest<ReadArticlesResponse>(
    admin,
    READ_ARTICLES_QUERY,
    {
      first: parsed.data.limit,
      after: null,
      query: queryString,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const articles = result.data.articles.edges.map((e) => nodeToSummary(e.node));
  return {
    ok: true,
    data: {
      blogId: parsed.data.blogId ?? null,
      articles,
      pageInfo: result.data.articles.pageInfo,
    },
  };
}

// ----------------------------------------------------------------------------
// createArticle
// ----------------------------------------------------------------------------

export async function createArticle(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ArticleSnapshot>> {
  const parsed = CreateArticleInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Resolve blogId. If the merchant didn't pass one, fall back to the
  // store's first blog (Shopify auto-creates "News" on every store).
  let blogId = parsed.data.blogId;
  if (!blogId) {
    const def = await getDefaultBlogId(admin);
    if (!def.ok) return def;
    blogId = def.data.blogId;
  }

  // Resolve author. Required by Shopify (ArticleCreateInput.author is
  // AuthorInput!) — falls back to the shop's display name when the merchant
  // didn't specify one.
  let authorName = parsed.data.author;
  if (authorName === undefined) {
    const def = await getDefaultAuthorName(admin);
    if (!def.ok) return def;
    authorName = def.data;
  }

  const articleInput: Record<string, unknown> = {
    blogId,
    title: parsed.data.title,
    body: parsed.data.body,
    isPublished: parsed.data.isPublished,
    author: { name: authorName },
  };
  if (parsed.data.summary !== undefined) articleInput.summary = parsed.data.summary;
  if (parsed.data.tags !== undefined) articleInput.tags = parsed.data.tags;
  if (parsed.data.imageUrl !== undefined) {
    articleInput.image = { url: parsed.data.imageUrl };
  }

  const result = await graphqlRequest<ArticleCreateResponse>(
    admin,
    ARTICLE_CREATE_MUTATION,
    { article: articleInput },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.articleCreate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const article = result.data.articleCreate.article;
  if (!article) return { ok: false, error: "articleCreate returned no article" };

  return { ok: true, data: nodeToSnapshot(article) };
}

// ----------------------------------------------------------------------------
// updateArticle
//
// Partial update — only the fields the caller sets are sent. `imageUrl: null`
// clears the image (Shopify's articleUpdate accepts `image: null` to detach).
// ----------------------------------------------------------------------------

export async function updateArticle(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ArticleSnapshot>> {
  const parsed = UpdateArticleInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const articleInput: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) articleInput.title = parsed.data.title;
  if (parsed.data.body !== undefined) articleInput.body = parsed.data.body;
  if (parsed.data.summary !== undefined) articleInput.summary = parsed.data.summary;
  if (parsed.data.author !== undefined) {
    articleInput.author = { name: parsed.data.author };
  }
  if (parsed.data.tags !== undefined) articleInput.tags = parsed.data.tags;
  if (parsed.data.imageUrl !== undefined) {
    articleInput.image =
      parsed.data.imageUrl === null ? null : { url: parsed.data.imageUrl };
  }
  if (parsed.data.isPublished !== undefined) {
    articleInput.isPublished = parsed.data.isPublished;
  }

  const result = await graphqlRequest<ArticleUpdateResponse>(
    admin,
    ARTICLE_UPDATE_MUTATION,
    { id: parsed.data.articleId, article: articleInput },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.articleUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const article = result.data.articleUpdate.article;
  if (!article) return { ok: false, error: "articleUpdate returned no article" };

  return { ok: true, data: nodeToSnapshot(article) };
}

// ----------------------------------------------------------------------------
// deleteArticle
//
// Defensive flow: fetch the article first, check the title matches the
// caller's confirmTitle (case-insensitive trim), then issue the delete.
// Two reasons:
//   1. An LLM that hallucinated an articleId can't accidentally delete an
//      unrelated post — the title check fails fast.
//   2. The fetched snapshot becomes the AuditLog before-state, so a
//      deleted article can be reconstructed from the log if the merchant
//      regrets it. (executor.server.ts also calls fetchArticle in
//      snapshotBefore — same data path; double-fetch is acceptable here
//      since delete is rare and the before-state needs to be accurate.)
// ----------------------------------------------------------------------------

export async function deleteArticle(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<DeletedArticleResult>> {
  const parsed = DeleteArticleInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const snap = await fetchArticle(admin, parsed.data.articleId);
  if (!snap.ok) return snap;

  const expected = snap.data.title.trim().toLowerCase();
  const actual = parsed.data.confirmTitle.trim().toLowerCase();
  if (expected !== actual) {
    return {
      ok: false,
      error: `confirmTitle mismatch: expected "${snap.data.title}", got "${parsed.data.confirmTitle}". Refusing to delete — re-fetch the article and pass its current title.`,
    };
  }

  const result = await graphqlRequest<ArticleDeleteResponse>(
    admin,
    ARTICLE_DELETE_MUTATION,
    { id: parsed.data.articleId },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.articleDelete.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const deletedId = result.data.articleDelete.deletedArticleId;
  if (!deletedId) {
    return { ok: false, error: "articleDelete returned no deletedArticleId" };
  }
  return {
    ok: true,
    data: {
      deletedArticleId: deletedId,
      title: snap.data.title,
    },
  };
}
