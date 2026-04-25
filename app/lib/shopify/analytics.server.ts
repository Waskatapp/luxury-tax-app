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

// Best-selling = most units sold in the window, aggregated from orders'
// line items. The root `products(sortKey: BEST_SELLING)` is INVALID at API
// 2026-04 — BEST_SELLING is a CollectionSortKeys value, not ProductSortKeys.
const TOP_PRODUCTS_FROM_ORDERS_QUERY = `#graphql
  query AnalyticsTopProductsFromOrders($first: Int!, $query: String!, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          lineItems(first: 10) {
            edges {
              node {
                quantity
                title
                product { id title handle }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type TopProductsFromOrdersResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        lineItems: {
          edges: Array<{
            node: {
              quantity: number;
              title: string;
              product: { id: string; title: string; handle: string } | null;
            };
          }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
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

// Smaller pages for top_products: each order pulls lineItems(first:10), so
// per-order GraphQL cost is ~12. Keep page-size × cost-per-order under the
// 1000-point bucket. 50 × 12 + overhead ≈ 650 — fits one bucket per page.
const TOP_PRODUCTS_ORDERS_PAGE_SIZE = 50;
const TOP_PRODUCTS_ORDERS_MAX_PAGES = 4; // hard cap → 200 orders scanned

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
    const startsAtDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const queryFilter = `created_at:>=${startsAtDate.toISOString()}`;

    type Tally = {
      productId: string;
      title: string;
      handle: string | null;
      unitsSold: number;
      orderIds: Set<string>;
    };
    const tallies = new Map<string, Tally>();

    let after: string | null = null;
    let cappedAtPageLimit = false;

    for (let page = 0; page < TOP_PRODUCTS_ORDERS_MAX_PAGES; page++) {
      const result: GraphQLResult<TopProductsFromOrdersResponse> =
        await graphqlRequest<TopProductsFromOrdersResponse>(
          admin,
          TOP_PRODUCTS_FROM_ORDERS_QUERY,
          {
            first: TOP_PRODUCTS_ORDERS_PAGE_SIZE,
            query: queryFilter,
            after,
          },
        );
      if (!result.ok) return { ok: false, error: result.error };

      for (const edge of result.data.orders.edges) {
        const orderId = edge.node.id;
        for (const li of edge.node.lineItems.edges) {
          const product = li.node.product;
          if (!product) continue; // line item from a deleted product
          const existing = tallies.get(product.id);
          if (existing) {
            existing.unitsSold += li.node.quantity;
            existing.orderIds.add(orderId);
          } else {
            tallies.set(product.id, {
              productId: product.id,
              title: product.title,
              handle: product.handle,
              unitsSold: li.node.quantity,
              orderIds: new Set([orderId]),
            });
          }
        }
      }

      if (!result.data.orders.pageInfo.hasNextPage) break;
      after = result.data.orders.pageInfo.endCursor;
      if (page === TOP_PRODUCTS_ORDERS_MAX_PAGES - 1) cappedAtPageLimit = true;
    }

    const products = Array.from(tallies.values())
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, TOP_PRODUCTS_LIMIT)
      .map((t) => ({
        id: t.productId,
        title: t.title,
        handle: t.handle,
        unitsSold: t.unitsSold,
        orderCount: t.orderIds.size,
      }));

    return {
      ok: true,
      data: {
        metric: "top_products",
        rangeDays: days,
        products,
        cappedAtPageLimit,
        note: cappedAtPageLimit
          ? `Ranking based on the most recent ${TOP_PRODUCTS_ORDERS_PAGE_SIZE * TOP_PRODUCTS_ORDERS_MAX_PAGES} orders in the window. Older orders weren't counted; ranking may be incomplete for high-volume stores.`
          : `Ranked by units sold across all orders in the last ${days} days.`,
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
