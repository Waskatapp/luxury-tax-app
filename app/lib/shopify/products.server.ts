import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ReadProductsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
});

const READ_PRODUCTS_QUERY = `#graphql
  query ReadProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          handle
          status
          productType
          vendor
          totalInventory
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType: string | null;
  vendor: string | null;
  totalInventory: number | null;
  priceRange: {
    min: { amount: string; currencyCode: string };
    max: { amount: string; currencyCode: string };
  };
};

export type ReadProductsResult = {
  products: ProductSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type RawResponse = {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        handle: string;
        status: string;
        productType: string | null;
        vendor: string | null;
        totalInventory: number | null;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string; currencyCode: string };
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export async function readProducts(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadProductsResult>> {
  const parsed = ReadProductsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<RawResponse>(admin, READ_PRODUCTS_QUERY, {
    first: parsed.data.first,
    after: parsed.data.after ?? null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const products: ProductSummary[] = result.data.products.edges.map((edge) => ({
    id: edge.node.id,
    title: edge.node.title,
    handle: edge.node.handle,
    status: edge.node.status,
    productType: edge.node.productType,
    vendor: edge.node.vendor,
    totalInventory: edge.node.totalInventory,
    priceRange: {
      min: edge.node.priceRangeV2.minVariantPrice,
      max: edge.node.priceRangeV2.maxVariantPrice,
    },
  }));

  return {
    ok: true,
    data: { products, pageInfo: result.data.products.pageInfo },
  };
}
