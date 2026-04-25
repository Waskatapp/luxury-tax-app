import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ReadCollectionsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
});

const READ_COLLECTIONS_QUERY = `#graphql
  query ReadCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          handle
          updatedAt
          productsCount { count }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type CollectionSummary = {
  id: string;
  title: string;
  handle: string;
  productsCount: number | null;
  updatedAt: string;
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
        productsCount: { count: number } | null;
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
  });
  if (!result.ok) return { ok: false, error: result.error };

  const collections: CollectionSummary[] = result.data.collections.edges.map(
    (edge) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      productsCount: edge.node.productsCount?.count ?? null,
      updatedAt: edge.node.updatedAt,
    }),
  );

  return {
    ok: true,
    data: { collections, pageInfo: result.data.collections.pageInfo },
  };
}
