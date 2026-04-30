import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type {
  DepartmentSpec,
  ToolHandler,
} from "../department-spec";

import { getAnalyticsHandler } from "./handlers";
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
    "Sales and inventory analytics. Three metrics: `top_products` returns the top 5 best-selling products by units sold across orders in the last `days` days — use this when the merchant asks for 'top sellers', 'best sellers', 'top N products', or 'most sold' (NOT for plain 'list my products' — that's a Products department job). `revenue` sums order totals over the last `days` days (default 30, max 365). `inventory_at_risk` returns variants with inventory below `threshold` (default 5). Read-only — no approval card.",
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

const INSIGHTS_SPEC: DepartmentSpec = {
  id: "insights",
  label: "Insights",
  managerTitle: "Insights manager",
  description:
    "Owns reading the store's pulse: revenue, top products, inventory at risk. Read-only.",
  systemPrompt: INSIGHTS_PROMPT,
  toolDeclarations: [getAnalyticsDeclaration],
  handlers: new Map<string, ToolHandler>([
    ["get_analytics", getAnalyticsHandler],
  ]),
  classification: {
    read: new Set(["get_analytics"]),
    write: new Set(),
    inlineWrite: new Set(),
  },
};

registerDepartment(INSIGHTS_SPEC);

export { INSIGHTS_SPEC };
