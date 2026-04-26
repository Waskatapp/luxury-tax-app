import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ReadCollectionsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
  // Same agentic search treatment as read_products: bare keywords match
  // across collection title, description, and rule set.
  query: z.string().optional(),
});

// description (server-truncated) + ruleSet preview let the agent
// disambiguate "the new arrivals collection" from "new sale items"
// without scanning every collection.
const READ_COLLECTIONS_QUERY = `#graphql
  query ReadCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          title
          handle
          updatedAt
          description
          sortOrder
          productsCount { count }
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
          seo {
            title
            description
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const DESCRIPTION_PREVIEW_CHARS = 300;

export type CollectionRuleSummary = {
  column: string;
  relation: string;
  condition: string;
};

export type CollectionSummary = {
  id: string;
  title: string;
  handle: string;
  productsCount: number | null;
  updatedAt: string;
  descriptionPreview: string | null;
  sortOrder: string | null;
  // Smart collections only — manual collections return null. The agent uses
  // this to explain WHY a product is in the collection (or to suggest
  // adding one to a smart rule).
  rules: {
    matchAny: boolean;
    items: CollectionRuleSummary[];
  } | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type ReadCollectionsResult = {
  collections: CollectionSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type RawResponse = {
  collections: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        handle: string;
        updatedAt: string;
        description: string | null;
        sortOrder: string | null;
        productsCount: { count: number } | null;
        ruleSet: {
          appliedDisjunctively: boolean;
          rules: Array<{ column: string; relation: string; condition: string }>;
        } | null;
        seo: { title: string | null; description: string | null } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export async function readCollections(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadCollectionsResult>> {
  const parsed = ReadCollectionsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<RawResponse>(admin, READ_COLLECTIONS_QUERY, {
    first: parsed.data.first,
    after: parsed.data.after ?? null,
    query: parsed.data.query ?? null,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const collections: CollectionSummary[] = result.data.collections.edges.map(
    (edge) => {
      const desc = edge.node.description?.trim() ?? "";
      const descPreview =
        desc.length > DESCRIPTION_PREVIEW_CHARS
          ? desc.slice(0, DESCRIPTION_PREVIEW_CHARS) + "…"
          : desc.length > 0
            ? desc
            : null;
      return {
        id: edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        productsCount: edge.node.productsCount?.count ?? null,
        updatedAt: edge.node.updatedAt,
        descriptionPreview: descPreview,
        sortOrder: edge.node.sortOrder,
        rules: edge.node.ruleSet
          ? {
              matchAny: edge.node.ruleSet.appliedDisjunctively,
              items: edge.node.ruleSet.rules,
            }
          : null,
        seoTitle: edge.node.seo?.title ?? null,
        seoDescription: edge.node.seo?.description ?? null,
      };
    },
  );

  return {
    ok: true,
    data: { collections, pageInfo: result.data.collections.pageInfo },
  };
}
