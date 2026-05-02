import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type {
  DepartmentSpec,
  ToolHandler,
} from "../department-spec";

import {
  createDiscountHandler,
  updateProductPriceHandler,
} from "./handlers";
import PRICING_PROMPT from "./prompt.md?raw";

// V-Sub-4 — Phase Sub-Agents Pricing & Promotions department. 2 write
// tools. The simplest department; pure write surface (no reads). The
// CEO is expected to read products/collections via Products department
// FIRST, then delegate to P&P with concrete variant IDs and prices in
// the task description.

const updateProductPriceDeclaration: FunctionDeclaration = {
  name: "update_product_price",
  description:
    "Update the price of a product variant. REQUIRES HUMAN APPROVAL — you only PROPOSE the change; an approval card is shown to the merchant in the main conversation and the CEO continues only after they approve. Never claim the change has been made before approval.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product GID, e.g. gid://shopify/Product/12345",
      },
      variantId: {
        type: "string",
        description: "Variant GID, e.g. gid://shopify/ProductVariant/67890",
      },
      newPrice: {
        type: "string",
        description: "Decimal string in the store's currency, e.g. \"19.99\"",
      },
    },
    required: ["productId", "variantId", "newPrice"],
  },
};

const createDiscountDeclaration: FunctionDeclaration = {
  name: "create_discount",
  description:
    "Create a percentage-off automatic discount. REQUIRES HUMAN APPROVAL. Provide the discount title, percent off (1-100), start date, and optional end date.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      percentOff: { type: "integer", minimum: 1, maximum: 100 },
      startsAt: { type: "string", format: "date-time" },
      endsAt: { type: "string", format: "date-time" },
    },
    required: ["title", "percentOff", "startsAt"],
  },
};

const PRICING_PROMOTIONS_SPEC: DepartmentSpec = {
  id: "pricing-promotions",
  label: "Pricing & Promotions",
  managerTitle: "Pricing & Promotions manager",
  description:
    "Owns prices and discounts: setting variant prices, creating percentage-off automatic discounts.",
  systemPrompt: PRICING_PROMPT,
  toolDeclarations: [
    updateProductPriceDeclaration,
    createDiscountDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["update_product_price", updateProductPriceHandler],
    ["create_discount", createDiscountHandler],
  ]),
  classification: {
    read: new Set(),
    write: new Set(["update_product_price", "create_discount"]),
    inlineWrite: new Set(),
  },
};

registerDepartment(PRICING_PROMOTIONS_SPEC);

export { PRICING_PROMOTIONS_SPEC };
