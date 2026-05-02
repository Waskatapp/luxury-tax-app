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

// V-IN-A — Round IN-A new tools.

export type ProductPerformanceResult = {
  productId: string;
  // Echoed back from the input when the CEO passes it in the task.
  // null when the merchant hasn't fetched the title via Products yet —
  // the CEO can fill from prior context if needed.
  productTitle: string | null;
  rangeDays: number;
  startsAt: string;
  endsAt: string;
  unitsSold: number;
  orderCount: number;
  revenue: string;            // decimal string, summed in cents to avoid drift
  currencyCode: string;
  cappedAtPageLimit: boolean;
  note: string;
};

export type ComparePeriodsWindow = {
  startsAt: string;
  endsAt: string;
  unitsSold: number;
  orderCount: number;
  revenue: string;
  currencyCode: string;
  cappedAtPageLimit: boolean;
};

export type ComparePeriodsDelta = {
  unitsSold: number;            // current - prior (signed)
  orderCount: number;
  revenue: string;              // current - prior (signed decimal string)
  // Percentage deltas are null when the prior window had 0 — avoids
  // Infinity / NaN leaking into the merchant-facing summary.
  unitsSoldPct: number | null;
  revenuePct: number | null;
};

export type ComparePeriodsResult = {
  // null = store-wide; non-null = product-specific.
  productId: string | null;
  productTitle: string | null;
  rangeDays: number;
  current: ComparePeriodsWindow;
  prior: ComparePeriodsWindow;
  delta: ComparePeriodsDelta;
  cappedAtPageLimit: boolean;   // true if EITHER window capped
  note: string;
};
