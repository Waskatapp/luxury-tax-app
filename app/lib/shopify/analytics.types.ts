// Pure types — split out of analytics.server.ts so client components
// (AnalyticsCard, dashboard) can import the result shapes without pulling
// in the .server.ts file's GraphQL plumbing.

export type AnalyticsTopProductsResult = {
  metric: "top_products";
  rangeDays: number;
  // Aggregated from orders' line items in the window. Products with no
  // surviving Shopify product reference (deleted) are excluded from the
  // ranking.
  products: Array<{
    id: string;
    title: string;
    handle: string | null;
    unitsSold: number;
    orderCount: number;
  }>;
  cappedAtPageLimit: boolean;
  note: string;
};

export type AnalyticsRevenueResult = {
  metric: "revenue";
  rangeDays: number;
  startsAt: string;
  endsAt: string;
  orderCount: number;
  totalRevenue: string;
  currencyCode: string;
  cappedAtPageLimit: boolean;
  note: string;
};

export type AnalyticsInventoryAtRiskResult = {
  metric: "inventory_at_risk";
  threshold: number;
  variants: Array<{
    productId: string;
    productTitle: string;
    productStatus: string;
    variantId: string;
    variantTitle: string;
    inventoryQuantity: number;
  }>;
  truncated: boolean;
};

export type AnalyticsResult =
  | AnalyticsTopProductsResult
  | AnalyticsRevenueResult
  | AnalyticsInventoryAtRiskResult;
