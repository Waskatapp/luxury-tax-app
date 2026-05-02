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
  ComparePeriodsResult,
  ProductPerformanceResult,
} from "./analytics.types";

export type {
  AnalyticsInventoryAtRiskResult,
  AnalyticsResult,
  AnalyticsRevenueResult,
  AnalyticsTopProductsResult,
  ComparePeriodsResult,
  ProductPerformanceResult,
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

// V3.2 — Phase 3 Autonomous Reasoning Loop. Per-window metrics, optionally
// filtered to a single product. Used by the offline evaluator to compute
// after-state metrics matching a followup's baseline. NOT exposed as a
// merchant-facing tool — the existing get_analytics is the merchant-facing
// surface.
//
// Returns:
//   { productId, startsAt, endsAt, unitsSold, orderCount, revenue, currencyCode }
//
// `productId === null` means "store-wide" (don't filter line items).
// `productId` non-null means filter the line items array on each order so
// only line items matching this product contribute to unitsSold / revenue.
//
// Scans up to PRODUCT_WINDOW_MAX_PAGES × PRODUCT_WINDOW_PAGE_SIZE orders
// (250 × 4 = 1000). For long windows or high-volume stores this caps; the
// `cappedAtPageLimit` flag flows up so the verdict can fall back to
// insufficient_data instead of misclassifying a partial scan.
//
// LIMITATIONS (deferred to Phase 3.4 / future):
//   - sessions / conversion_rate are NOT computable here. Shopify Admin API
//     doesn't expose session data. The evaluator returns insufficient_data
//     for those metrics until a Storefront-Analytics or external (GA / GSC)
//     integration ships.

const PRODUCT_WINDOW_PAGE_SIZE = 250;
const PRODUCT_WINDOW_MAX_PAGES = 4;

const PRODUCT_WINDOW_QUERY = `#graphql
  query AnalyticsProductWindow($first: Int!, $query: String!, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          createdAt
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          lineItems(first: 50) {
            edges {
              node {
                quantity
                originalUnitPriceSet {
                  shopMoney { amount currencyCode }
                }
                product { id }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type ProductWindowResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        createdAt: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        lineItems: {
          edges: Array<{
            node: {
              quantity: number;
              originalUnitPriceSet: {
                shopMoney: { amount: string; currencyCode: string };
              };
              product: { id: string } | null;
            };
          }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type ProductWindowResult = {
  productId: string | null;
  startsAt: string;
  endsAt: string;
  unitsSold: number;
  orderCount: number;
  revenue: string; // decimal string, summed in cents to avoid float drift
  currencyCode: string;
  cappedAtPageLimit: boolean;
};

export async function getProductWindowAnalytics(
  admin: ShopifyAdmin,
  opts: { productId?: string | null; startsAt: Date; endsAt: Date },
): Promise<ToolModuleResult<ProductWindowResult>> {
  const productId = opts.productId ?? null;
  const startsAt = opts.startsAt.toISOString();
  const endsAt = opts.endsAt.toISOString();
  const queryFilter = `created_at:>=${startsAt} AND created_at:<${endsAt}`;

  let unitsSold = 0;
  let orderCount = 0;
  let totalCents = 0;
  let currencyCode = "USD";
  let after: string | null = null;
  let cappedAtPageLimit = false;

  for (let page = 0; page < PRODUCT_WINDOW_MAX_PAGES; page++) {
    const result: GraphQLResult<ProductWindowResponse> =
      await graphqlRequest<ProductWindowResponse>(
        admin,
        PRODUCT_WINDOW_QUERY,
        { first: PRODUCT_WINDOW_PAGE_SIZE, query: queryFilter, after },
      );
    if (!result.ok) return { ok: false, error: result.error };

    for (const edge of result.data.orders.edges) {
      let orderContributed = false;
      // Line-item-level walk: if productId is set, only count that
      // product; if null, count every line item but the order's full
      // total revenue (we use line-item-summed revenue when productId is
      // set; total order revenue when null, since that's what merchants
      // associate with a "store-wide" measurement).
      if (productId === null) {
        const amount = edge.node.totalPriceSet.shopMoney.amount;
        currencyCode = edge.node.totalPriceSet.shopMoney.currencyCode;
        totalCents += Math.round(parseFloat(amount) * 100);
        for (const li of edge.node.lineItems.edges) {
          unitsSold += li.node.quantity;
        }
        orderContributed = true;
      } else {
        for (const li of edge.node.lineItems.edges) {
          if (!li.node.product || li.node.product.id !== productId) continue;
          unitsSold += li.node.quantity;
          const lineAmount = parseFloat(
            li.node.originalUnitPriceSet.shopMoney.amount,
          );
          currencyCode = li.node.originalUnitPriceSet.shopMoney.currencyCode;
          totalCents += Math.round(lineAmount * li.node.quantity * 100);
          orderContributed = true;
        }
      }
      if (orderContributed) orderCount += 1;
    }

    if (!result.data.orders.pageInfo.hasNextPage) break;
    after = result.data.orders.pageInfo.endCursor;
    if (page === PRODUCT_WINDOW_MAX_PAGES - 1) cappedAtPageLimit = true;
  }

  return {
    ok: true,
    data: {
      productId,
      startsAt,
      endsAt,
      unitsSold,
      orderCount,
      revenue: (totalCents / 100).toFixed(2),
      currencyCode,
      cappedAtPageLimit,
    },
  };
}

// ============================================================================
// V-IN-A — get_product_performance + compare_periods (merchant-facing tools)
//
// Both wrap getProductWindowAnalytics. The hard work (order pagination,
// line-item filtering, currency-precise summing) already happens there;
// these wrappers are mostly Zod input shaping, days→date math, and
// merchant-friendly result decoration.
// ============================================================================

const GetProductPerformanceInput = z.object({
  productId: z.string().min(1),
  days: z.number().int().min(1).max(365).default(30),
  // Optional — the CEO passes the title in the task description after
  // a Products read. The handler echoes it back so the result is self-
  // describing. Don't fetch separately; that would double the Shopify
  // call cost on every delegation.
  productTitle: z.string().min(1).max(255).optional(),
});

export async function getProductPerformance(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductPerformanceResult>> {
  const parsed = GetProductPerformanceInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }
  const { productId, days, productTitle } = parsed.data;

  const endsAt = new Date();
  const startsAt = new Date(endsAt.getTime() - days * 24 * 60 * 60 * 1000);

  const window = await getProductWindowAnalytics(admin, {
    productId,
    startsAt,
    endsAt,
  });
  if (!window.ok) return window;

  const note = window.data.cappedAtPageLimit
    ? `Order scan capped at ${PRODUCT_WINDOW_PAGE_SIZE * PRODUCT_WINDOW_MAX_PAGES} orders. Numbers may be incomplete; suggest a shorter window.`
    : window.data.unitsSold === 0
      ? `No sales of this product in the last ${days} days.`
      : `Computed across all orders in the last ${days} days. Revenue is line-item revenue (unit price × quantity), not full order totals.`;

  return {
    ok: true,
    data: {
      productId,
      productTitle: productTitle ?? null,
      rangeDays: days,
      startsAt: window.data.startsAt,
      endsAt: window.data.endsAt,
      unitsSold: window.data.unitsSold,
      orderCount: window.data.orderCount,
      revenue: window.data.revenue,
      currencyCode: window.data.currencyCode,
      cappedAtPageLimit: window.data.cappedAtPageLimit,
      note,
    },
  };
}

const ComparePeriodsInput = z.object({
  productId: z.string().min(1).optional(),
  days: z.number().int().min(1).max(365).default(30),
  productTitle: z.string().min(1).max(255).optional(),
});

// Compute percentage delta as (current - prior) / prior * 100, but
// return null when prior is 0 — avoids Infinity / NaN bleeding into
// the merchant-facing summary. The note will explain when this happens.
function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

export async function comparePeriods(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ComparePeriodsResult>> {
  const parsed = ComparePeriodsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }
  const { productId, days, productTitle } = parsed.data;

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - days * dayMs);
  // Same-length prior window, ending where the current window starts.
  const priorEnd = currentStart;
  const priorStart = new Date(currentStart.getTime() - days * dayMs);

  // Sequential — keeps within rate-limiter budget. The two windows are
  // independent so parallel would also work, but sequential is simpler
  // and analytics queries aren't latency-critical.
  const currentResult = await getProductWindowAnalytics(admin, {
    productId: productId ?? null,
    startsAt: currentStart,
    endsAt: currentEnd,
  });
  if (!currentResult.ok) return currentResult;

  const priorResult = await getProductWindowAnalytics(admin, {
    productId: productId ?? null,
    startsAt: priorStart,
    endsAt: priorEnd,
  });
  if (!priorResult.ok) return priorResult;

  const c = currentResult.data;
  const p = priorResult.data;

  // Revenue delta in cents to avoid float drift, then formatted.
  const cCents = Math.round(parseFloat(c.revenue) * 100);
  const pCents = Math.round(parseFloat(p.revenue) * 100);
  const revenueDeltaCents = cCents - pCents;
  const revenueDelta = (revenueDeltaCents / 100).toFixed(2);

  const cappedAtPageLimit = c.cappedAtPageLimit || p.cappedAtPageLimit;

  const note = cappedAtPageLimit
    ? `One or both windows hit the order-scan cap (${PRODUCT_WINDOW_PAGE_SIZE * PRODUCT_WINDOW_MAX_PAGES} orders). Deltas may be incomplete; consider a shorter window.`
    : p.orderCount === 0 && c.orderCount === 0
      ? `No orders in either window for this scope.`
      : p.orderCount === 0
        ? `Prior window had no orders — percentage change can't be computed (would be infinite).`
        : `Compared ${days}-day window ending now vs the prior ${days} days.`;

  return {
    ok: true,
    data: {
      productId: productId ?? null,
      productTitle: productTitle ?? null,
      rangeDays: days,
      current: {
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        unitsSold: c.unitsSold,
        orderCount: c.orderCount,
        revenue: c.revenue,
        currencyCode: c.currencyCode,
        cappedAtPageLimit: c.cappedAtPageLimit,
      },
      prior: {
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        unitsSold: p.unitsSold,
        orderCount: p.orderCount,
        revenue: p.revenue,
        currencyCode: p.currencyCode,
        cappedAtPageLimit: p.cappedAtPageLimit,
      },
      delta: {
        unitsSold: c.unitsSold - p.unitsSold,
        orderCount: c.orderCount - p.orderCount,
        revenue: revenueDelta,
        unitsSoldPct: pctDelta(c.unitsSold, p.unitsSold),
        revenuePct: pctDelta(cCents, pCents),
      },
      cappedAtPageLimit,
      note,
    },
  };
}
