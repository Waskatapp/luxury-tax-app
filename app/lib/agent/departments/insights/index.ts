import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type {
  DepartmentSpec,
  ToolHandler,
} from "../department-spec";

import {
  comparePeriodsHandler,
  getAnalyticsHandler,
  getProductPerformanceHandler,
} from "./handlers";
import INSIGHTS_PROMPT from "./prompt.md?raw";

// V-Sub-2 — Phase Sub-Agents Insights department. The first real
// migration. Owns ONE tool today (get_analytics); future expansion
// could add cohort analytics, customer LTV, conversion funnels, etc.
//
// Migration posture: the underlying analytics.server.ts module is
// UNTOUCHED. This module just wraps it in the department/handler shape.
// All existing tests for getAnalytics() continue to pass.

const getAnalyticsDeclaration: FunctionDeclaration = {
  name: "get_analytics",
  description:
    "Sales and inventory analytics. Three metrics: `top_products` returns the top 5 best-selling products by units sold across orders in the last `days` days — use this when the merchant asks for 'top sellers', 'best sellers', 'top N products', or 'most sold' (NOT for plain 'list my products' — that's a Products department job). `revenue` sums order totals over the last `days` days (default 30, max 365). `inventory_at_risk` returns variants with inventory below `threshold` (default 5). Read-only — no approval card.\n\n**For richer ranked queries, prefer `get_top_performers`** — it adds bottom-performer (underperformer) listings, revenue-based sorting, and configurable limit. `get_analytics(top_products)` stays for the simple case.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: ["top_products", "revenue", "inventory_at_risk"],
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description:
          "Lookback window in days. Defaults to 30. Used by `revenue`; ignored by `inventory_at_risk`.",
      },
      threshold: {
        type: "integer",
        minimum: 0,
        maximum: 1000,
        description:
          "Inventory threshold for `inventory_at_risk`. Variants with quantity below this are flagged. Defaults to 5.",
      },
    },
    required: ["metric"],
  },
};

const getProductPerformanceDeclaration: FunctionDeclaration = {
  name: "get_product_performance",
  description:
    "Per-product analytics for a single product over a time window. Returns unitsSold, orderCount, revenue, and currencyCode for the last `days` days (default 30). Use this when the merchant asks 'how is X doing?' / 'how is Cat Food selling?' / 'what's Cat Food's revenue this month?'. **Requires the productId** — the CEO must chain a Products read FIRST to get the GID. The CEO should also pass `productTitle` along in the task description so the result is self-describing without an extra fetch. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description:
          "Product GID, e.g. gid://shopify/Product/12345. Get this from a Products delegation first — never fabricate.",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Lookback window in days. Defaults to 30.",
      },
      productTitle: {
        type: "string",
        description:
          "Optional product title for self-describing results. Pass this along when chaining from a Products read so the merchant's reply doesn't need another fetch.",
      },
    },
    required: ["productId"],
  },
};

const comparePeriodsDeclaration: FunctionDeclaration = {
  name: "compare_periods",
  description:
    "Compare a current N-day window against the same-length prior window. Returns absolute deltas + percentage changes for unitsSold, orderCount, and revenue. Use this when the merchant asks comparison questions: 'how is X doing this month vs last?' / 'is the store growing?' / 'are sales up or down YoY?' (use days=365 for year-over-year on a 365-day comparison). Pass `productId` for product-specific comparison; omit for store-wide.\n\nPercentage deltas are `null` when the prior period had 0 — the result's `note` will explain. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description:
          "Optional product GID. Omit for store-wide comparison. When passed, only line items for this product are tallied.",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description:
          "Length of each comparison window in days. Defaults to 30. Current = last `days` days; prior = the `days` days before that.",
      },
      productTitle: {
        type: "string",
        description:
          "Optional product title for self-describing results. Pass this along when chaining from a Products read.",
      },
    },
  },
};

const INSIGHTS_SPEC: DepartmentSpec = {
  id: "insights",
  label: "Insights",
  managerTitle: "Insights manager",
  description:
    "Owns reading the store's pulse: revenue, top sellers / underperformers, inventory at risk, per-product performance, and period-over-period comparisons. Read-only.",
  systemPrompt: INSIGHTS_PROMPT,
  toolDeclarations: [
    getAnalyticsDeclaration,
    getProductPerformanceDeclaration,
    comparePeriodsDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["get_analytics", getAnalyticsHandler],
    ["get_product_performance", getProductPerformanceHandler],
    ["compare_periods", comparePeriodsHandler],
  ]),
  classification: {
    read: new Set([
      "get_analytics",
      "get_product_performance",
      "compare_periods",
    ]),
    write: new Set(),
    inlineWrite: new Set(),
  },
};

registerDepartment(INSIGHTS_SPEC);

export { INSIGHTS_SPEC };
