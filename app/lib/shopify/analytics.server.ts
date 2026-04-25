import { z } from "zod";

import {
  graphqlRequest,
  type GraphQLResult,
  type ShopifyAdmin,
} from "./graphql-client.server";
import type {
  AnalyticsInventoryAtRiskResult,
  AnalyticsResult,
  AnalyticsRevenueResult,
  AnalyticsTopProductsResult,
} from "./analytics.types";

export type {
  AnalyticsInventoryAtRiskResult,
  AnalyticsResult,
  AnalyticsRevenueResult,
  AnalyticsTopProductsResult,
};

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

const GetAnalyticsInput = z.object({
  metric: z.enum(["top_products", "revenue", "inventory_at_risk"]),
  days: z.number().int().min(1).max(365).default(30),
  threshold: z.number().int().min(0).max(1000).default(5),
});

const TOP_PRODUCTS_QUERY = `#graphql
  query AnalyticsTopProducts($first: Int!) {
    products(first: $first, sortKey: BEST_SELLING) {
      edges {
        node {
          id
          title
          handle
          status
          totalInventory
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

type TopProductsResponse = {
  products: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        handle: string;
        status: string;
        totalInventory: number | null;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string; currencyCode: string };
        };
      };
    }>;
  };
};

const REVENUE_QUERY = `#graphql
  query AnalyticsRevenue($first: Int!, $query: String!, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          createdAt
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type RevenueResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        createdAt: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const INVENTORY_AT_RISK_QUERY = `#graphql
  query AnalyticsInventoryAtRisk($first: Int!, $query: String!) {
    productVariants(first: $first, query: $query) {
      edges {
        node {
          id
          title
          inventoryQuantity
          product {
            id
            title
            status
          }
        }
      }
    }
  }
`;

type InventoryAtRiskResponse = {
  productVariants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        inventoryQuantity: number | null;
        product: { id: string; title: string; status: string } | null;
      };
    }>;
  };
};

const REVENUE_PAGE_SIZE = 250;
const REVENUE_MAX_PAGES = 4; // hard cap → 1000 orders
const INVENTORY_AT_RISK_LIMIT = 50;
const TOP_PRODUCTS_LIMIT = 5;

export async function getAnalytics(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<AnalyticsResult>> {
  const parsed = GetAnalyticsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const { metric, days, threshold } = parsed.data;

  if (metric === "top_products") {
    const result = await graphqlRequest<TopProductsResponse>(
      admin,
      TOP_PRODUCTS_QUERY,
      { first: TOP_PRODUCTS_LIMIT },
    );
    if (!result.ok) return { ok: false, error: result.error };

    const products = result.data.products.edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      status: edge.node.status,
      totalInventory: edge.node.totalInventory,
      priceRange: {
        min: edge.node.priceRangeV2.minVariantPrice,
        max: edge.node.priceRangeV2.maxVariantPrice,
      },
    }));

    return {
      ok: true,
      data: {
        metric: "top_products",
        rangeDays: days,
        products,
        note:
          "Ranking is Shopify's BEST_SELLING sort (a recency-weighted velocity score), not a strict N-day count.",
      },
    };
  }

  if (metric === "revenue") {
    const startsAtDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const startsAt = startsAtDate.toISOString();
    const endsAt = new Date().toISOString();
    const queryFilter = `created_at:>=${startsAt}`;

    let totalCents = 0;
    let orderCount = 0;
    let currencyCode = "USD";
    let after: string | null = null;
    let cappedAtPageLimit = false;

    for (let page = 0; page < REVENUE_MAX_PAGES; page++) {
      const result: GraphQLResult<RevenueResponse> = await graphqlRequest<RevenueResponse>(
        admin,
        REVENUE_QUERY,
        { first: REVENUE_PAGE_SIZE, query: queryFilter, after },
      );
      if (!result.ok) return { ok: false, error: result.error };

      for (const edge of result.data.orders.edges) {
        const amount = edge.node.totalPriceSet.shopMoney.amount;
        currencyCode = edge.node.totalPriceSet.shopMoney.currencyCode;
        // Sum in cents to avoid float drift.
        totalCents += Math.round(parseFloat(amount) * 100);
        orderCount += 1;
      }

      if (!result.data.orders.pageInfo.hasNextPage) break;
      after = result.data.orders.pageInfo.endCursor;
      if (page === REVENUE_MAX_PAGES - 1) cappedAtPageLimit = true;
    }

    const totalRevenue = (totalCents / 100).toFixed(2);

    return {
      ok: true,
      data: {
        metric: "revenue",
        rangeDays: days,
        startsAt,
        endsAt,
        orderCount,
        totalRevenue,
        currencyCode,
        cappedAtPageLimit,
        note: cappedAtPageLimit
          ? `Order scan capped at ${REVENUE_PAGE_SIZE * REVENUE_MAX_PAGES} orders. Revenue figure may be incomplete; suggest a shorter window.`
          : "Revenue includes shipping and tax (gross). Refunds are not subtracted in v1.",
      },
    };
  }

  // inventory_at_risk
  const queryFilter = `inventory_quantity:<${threshold}`;
  const result = await graphqlRequest<InventoryAtRiskResponse>(
    admin,
    INVENTORY_AT_RISK_QUERY,
    { first: INVENTORY_AT_RISK_LIMIT, query: queryFilter },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const variants = result.data.productVariants.edges
    .filter((edge) => edge.node.product !== null && edge.node.inventoryQuantity !== null)
    .map((edge) => ({
      productId: edge.node.product!.id,
      productTitle: edge.node.product!.title,
      productStatus: edge.node.product!.status,
      variantId: edge.node.id,
      variantTitle: edge.node.title,
      inventoryQuantity: edge.node.inventoryQuantity as number,
    }))
    .sort((a, b) => a.inventoryQuantity - b.inventoryQuantity);

  return {
    ok: true,
    data: {
      metric: "inventory_at_risk",
      threshold,
      variants,
      truncated: result.data.productVariants.edges.length >= INVENTORY_AT_RISK_LIMIT,
    },
  };
}
