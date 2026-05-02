// V-Mkt-C — Marketing department static pages. Reads + writes for the
// store's static content pages (About, FAQ, Shipping Policy, Returns,
// Privacy, etc.). Structurally similar to articles.server.ts but simpler:
// no parent "blog" container, no author field, no tags, no featured
// image. Pages are single-author static content; articles are dated
// editorial content.
//
// Scopes: read_content (read), write_content (mutations) — both already
// added to shopify.app.toml in Round Mkt-B for articles. Round Mkt-C
// requires no manifest changes.
//
// Defensive pattern: deletePage requires a confirmTitle that must match
// the live page's title (case-insensitive trim) before the delete runs.
// Same rationale as deleteArticle — guards against an LLM hallucinating
// a pageId and accidentally deleting the wrong static page (e.g. wiping
// the merchant's Shipping Policy because the model confused it with an
// archived FAQ).

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Snapshot shapes
// ----------------------------------------------------------------------------

export type PageSnapshot = {
  pageId: string;
  title: string;
  handle: string;
  body: string;
  bodySummary: string | null;
  templateSuffix: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

export type PageSummary = {
  pageId: string;
  title: string;
  handle: string;
  bodySummary: string | null;
  templateSuffix: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

export type ReadPagesResult = {
  pages: PageSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type DeletedPageResult = {
  deletedPageId: string;
  title: string;
};

// ----------------------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------------------

const TITLE_MAX = 255;
const TEMPLATE_SUFFIX_MAX = 255;

export const ReadPagesInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().optional(),
});

export const CreatePageInput = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  body: z.string().min(1),
  templateSuffix: z.string().max(TEMPLATE_SUFFIX_MAX).optional(),
  // Default false — published pages are public on the storefront. Same
  // rationale as create_article: explicit opt-in for publishing prevents
  // accidentally going live.
  isPublished: z.boolean().default(false),
});

export const UpdatePageInput = z
  .object({
    pageId: z.string().min(1),
    title: z.string().min(1).max(TITLE_MAX).optional(),
    body: z.string().min(1).optional(),
    // null clears the template suffix (Shopify falls back to page.liquid).
    templateSuffix: z.string().max(TEMPLATE_SUFFIX_MAX).nullable().optional(),
    isPublished: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.templateSuffix !== undefined ||
      v.isPublished !== undefined,
    { message: "must provide at least one field to update" },
  );

export const DeletePageInput = z.object({
  pageId: z.string().min(1),
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

const FETCH_PAGE_QUERY = `#graphql
  query FetchPage($id: ID!) {
    page(id: $id) {
      id
      title
      handle
      body
      bodySummary
      templateSuffix
      isPublished
      publishedAt
      updatedAt
    }
  }
`;

const READ_PAGES_QUERY = `#graphql
  query ReadPages($first: Int!, $after: String, $query: String) {
    pages(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          title
          handle
          bodySummary
          templateSuffix
          isPublished
          publishedAt
          updatedAt
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PAGE_CREATE_MUTATION = `#graphql
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        title
        handle
        body
        bodySummary
        templateSuffix
        isPublished
        publishedAt
        updatedAt
      }
      userErrors { field message code }
    }
  }
`;

const PAGE_UPDATE_MUTATION = `#graphql
  mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
        handle
        body
        bodySummary
        templateSuffix
        isPublished
        publishedAt
        updatedAt
      }
      userErrors { field message code }
    }
  }
`;

const PAGE_DELETE_MUTATION = `#graphql
  mutation PageDelete($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors { field message code }
    }
  }
`;

// ----------------------------------------------------------------------------
// GraphQL response types
// ----------------------------------------------------------------------------

type PageNode = {
  id: string;
  title: string;
  handle: string;
  body: string | null;
  bodySummary: string | null;
  templateSuffix: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

type PageListNode = Omit<PageNode, "body">;

type FetchPageResponse = { page: PageNode | null };

type ReadPagesResponse = {
  pages: {
    edges: Array<{ cursor: string; node: PageListNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type PageCreateResponse = {
  pageCreate: {
    page: PageNode | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

type PageUpdateResponse = {
  pageUpdate: {
    page: PageNode | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

type PageDeleteResponse = {
  pageDelete: {
    deletedPageId: string | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

// ----------------------------------------------------------------------------
// Mappers
// ----------------------------------------------------------------------------

function nodeToSnapshot(node: PageNode): PageSnapshot {
  return {
    pageId: node.id,
    title: node.title,
    handle: node.handle,
    body: node.body ?? "",
    bodySummary: node.bodySummary,
    templateSuffix: node.templateSuffix,
    isPublished: node.isPublished,
    publishedAt: node.publishedAt,
    updatedAt: node.updatedAt,
  };
}

function nodeToSummary(node: PageListNode): PageSummary {
  return {
    pageId: node.id,
    title: node.title,
    handle: node.handle,
    bodySummary: node.bodySummary,
    templateSuffix: node.templateSuffix,
    isPublished: node.isPublished,
    publishedAt: node.publishedAt,
    updatedAt: node.updatedAt,
  };
}

// ----------------------------------------------------------------------------
// fetchPage — snapshot helper for executor.snapshotBefore + deletePage gate
// ----------------------------------------------------------------------------

export async function fetchPage(
  admin: ShopifyAdmin,
  pageId: string,
): Promise<ToolModuleResult<PageSnapshot>> {
  const result = await graphqlRequest<FetchPageResponse>(
    admin,
    FETCH_PAGE_QUERY,
    { id: pageId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.page) {
    return { ok: false, error: `page not found: ${pageId}` };
  }
  return { ok: true, data: nodeToSnapshot(result.data.page) };
}

// ----------------------------------------------------------------------------
// readPages
// ----------------------------------------------------------------------------

export async function readPages(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadPagesResult>> {
  const parsed = ReadPagesInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ReadPagesResponse>(
    admin,
    READ_PAGES_QUERY,
    {
      first: parsed.data.limit,
      after: null,
      query: parsed.data.query ?? null,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const pages = result.data.pages.edges.map((e) => nodeToSummary(e.node));
  return {
    ok: true,
    data: {
      pages,
      pageInfo: result.data.pages.pageInfo,
    },
  };
}

// ----------------------------------------------------------------------------
// createPage
// ----------------------------------------------------------------------------

export async function createPage(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<PageSnapshot>> {
  const parsed = CreatePageInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const pageInput: Record<string, unknown> = {
    title: parsed.data.title,
    body: parsed.data.body,
    isPublished: parsed.data.isPublished,
  };
  if (parsed.data.templateSuffix !== undefined) {
    pageInput.templateSuffix = parsed.data.templateSuffix;
  }

  const result = await graphqlRequest<PageCreateResponse>(
    admin,
    PAGE_CREATE_MUTATION,
    { page: pageInput },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.pageCreate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const page = result.data.pageCreate.page;
  if (!page) return { ok: false, error: "pageCreate returned no page" };

  return { ok: true, data: nodeToSnapshot(page) };
}

// ----------------------------------------------------------------------------
// updatePage — partial update; templateSuffix:null clears it
// ----------------------------------------------------------------------------

export async function updatePage(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<PageSnapshot>> {
  const parsed = UpdatePageInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const pageInput: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) pageInput.title = parsed.data.title;
  if (parsed.data.body !== undefined) pageInput.body = parsed.data.body;
  if (parsed.data.templateSuffix !== undefined) {
    // null is a valid value here — Shopify's pageUpdate accepts null to
    // clear the templateSuffix (page.liquid becomes the default again).
    pageInput.templateSuffix = parsed.data.templateSuffix;
  }
  if (parsed.data.isPublished !== undefined) {
    pageInput.isPublished = parsed.data.isPublished;
  }

  const result = await graphqlRequest<PageUpdateResponse>(
    admin,
    PAGE_UPDATE_MUTATION,
    { id: parsed.data.pageId, page: pageInput },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.pageUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const page = result.data.pageUpdate.page;
  if (!page) return { ok: false, error: "pageUpdate returned no page" };

  return { ok: true, data: nodeToSnapshot(page) };
}

// ----------------------------------------------------------------------------
// deletePage — same defensive flow as deleteArticle (fetch → check title →
// delete). The fetched snapshot becomes the AuditLog before-state so a
// deleted page's full body can be reconstructed if the merchant regrets it.
// ----------------------------------------------------------------------------

export async function deletePage(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<DeletedPageResult>> {
  const parsed = DeletePageInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const snap = await fetchPage(admin, parsed.data.pageId);
  if (!snap.ok) return snap;

  const expected = snap.data.title.trim().toLowerCase();
  const actual = parsed.data.confirmTitle.trim().toLowerCase();
  if (expected !== actual) {
    return {
      ok: false,
      error: `confirmTitle mismatch: expected "${snap.data.title}", got "${parsed.data.confirmTitle}". Refusing to delete — re-fetch the page and pass its current title.`,
    };
  }

  const result = await graphqlRequest<PageDeleteResponse>(
    admin,
    PAGE_DELETE_MUTATION,
    { id: parsed.data.pageId },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.pageDelete.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const deletedId = result.data.pageDelete.deletedPageId;
  if (!deletedId) {
    return { ok: false, error: "pageDelete returned no deletedPageId" };
  }
  return {
    ok: true,
    data: {
      deletedPageId: deletedId,
      title: snap.data.title,
    },
  };
}
