import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type {
  DepartmentSpec,
  ToolHandler,
} from "../department-spec";

import {
  bulkUpdatePricesHandler,
  createDiscountHandler,
  deleteDiscountHandler,
  readDiscountsHandler,
  setDiscountStatusHandler,
  updateCompareAtPriceHandler,
  updateDiscountHandler,
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

const updateCompareAtPriceDeclaration: FunctionDeclaration = {
  name: "update_compare_at_price",
  description:
    "Set the variant's compare-at-price (the strikethrough \"was $X\" Shopify shows on the storefront when compareAtPrice > price). Use this when the merchant wants to mark a product as on sale: set compareAtPrice to the original/regular price, then leave or update the actual price as the sale price. To CLEAR the strikethrough (return to normal pricing), pass newCompareAtPrice as \"\" or \"0\". REQUIRES HUMAN APPROVAL.",
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
      newCompareAtPrice: {
        type: "string",
        description:
          'Decimal string in the store currency (e.g. "29.99"), or "" / "0" to clear the strikethrough.',
      },
    },
    required: ["productId", "variantId", "newCompareAtPrice"],
  },
};

const bulkUpdatePricesDeclaration: FunctionDeclaration = {
  name: "bulk_update_prices",
  description:
    "Apply a percentage or fixed-amount price change across many variants in one operation. Specify EXACTLY ONE scope: collectionId (every product in a collection), productIds (an explicit product list), or variantIds (an explicit variant list). REQUIRES HUMAN APPROVAL. Caps: 50 products (collection or productIds path) or 100 variants (variantIds path). Refuses to proceed if any computed new price would be negative — surfaces the offending variants instead. Compare-at-price is NOT touched by this tool — only the regular price.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      collectionId: {
        type: "string",
        description:
          "Apply to all products in this collection. Capped at 50 products; if exceeded, the tool errors and the merchant must scope down.",
      },
      productIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Apply to all variants of these specific products. Capped at 50 products.",
      },
      variantIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Apply to these specific variants only. Capped at 100 variants.",
      },
      changeType: {
        type: "string",
        enum: ["percentage", "fixed_amount"],
        description:
          "How to interpret changeValue. percentage = multiply price (changeValue interpreted as percent: 10 = +10%, -15 = -15%). fixed_amount = add to price (changeValue interpreted as money in store currency: 5.00 = +$5, -2.50 = -$2.50).",
      },
      changeValue: {
        type: "number",
        description:
          "The change to apply. For percentage: -100 to +500 (positive = mark up, negative = discount). For fixed_amount: -100000 to +100000 in store currency. Cannot be 0.",
      },
      roundTo: {
        type: "string",
        enum: [".99", ".95", ".00"],
        description:
          'Optional pretty-rounding ending. ".99" → land on $X.99. ".95" → $X.95. ".00" → whole dollar. Applied AFTER computing the new price; rounds DOWN so the new price is never higher than the unrounded compute.',
      },
    },
    required: ["changeType", "changeValue"],
  },
};

const readDiscountsDeclaration: FunctionDeclaration = {
  name: "read_discounts",
  description:
    "List discounts on the store: automatic + code, basic + bundle (Bxgy) + free-shipping. Returns id, title, type, status (ACTIVE / SCHEDULED / EXPIRED), startsAt, endsAt, a summary string Shopify renders, and (for code discounts) the code itself + total redemptions.\n\nThe `query` parameter is a Shopify search string. Bare keywords match across title; `field:value` narrows: `status:active`, `status:expired`, `title:summer`. Use this BEFORE update_discount, set_discount_status, or delete_discount — those tools require the discount's id, which the merchant doesn't know.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      first: { type: "integer", minimum: 1, maximum: 50 },
      after: { type: "string" },
      query: {
        type: "string",
        description:
          "Shopify search query. Bare keywords match titles; field-prefixed forms narrow (e.g. `status:active`, `title:summer`).",
      },
    },
  },
};

const updateDiscountDeclaration: FunctionDeclaration = {
  name: "update_discount",
  description:
    "Update an existing automatic BASIC discount's title, dates, and/or percent off. Pass at least one optional field. Bundle (Bxgy) discounts CANNOT be updated by this tool — to change a bundle, delete it and recreate via create_bundle_discount. To CLEAR an existing endsAt (run indefinitely), pass `endsAt: null` explicitly. Always call read_discounts first to find the discount's id. REQUIRES HUMAN APPROVAL.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      discountId: {
        type: "string",
        description: "Discount node GID, e.g. gid://shopify/DiscountAutomaticNode/12345. Get this from read_discounts.",
      },
      title: { type: "string", description: "New title (1-255 chars)." },
      percentOff: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "New percent off (1-100).",
      },
      startsAt: {
        type: "string",
        format: "date-time",
        description: "New start datetime (ISO-8601).",
      },
      endsAt: {
        type: "string",
        format: "date-time",
        description:
          "New end datetime (ISO-8601). Pass null to clear (run indefinitely).",
      },
    },
    required: ["discountId"],
  },
};

const setDiscountStatusDeclaration: FunctionDeclaration = {
  name: "set_discount_status",
  description:
    "Pause or resume an existing automatic discount. Works for both basic and bundle (Bxgy) discounts. PAUSED keeps the discount in the list but stops it from running on the storefront — fully reversible by calling this tool again with status=ACTIVE. Use this instead of delete_discount when the merchant might want to resume the offer later. Always call read_discounts first to find the discount's id. REQUIRES HUMAN APPROVAL.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      discountId: {
        type: "string",
        description: "Discount node GID. Get this from read_discounts.",
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "PAUSED"],
        description:
          "ACTIVE = resume / make live. PAUSED = stop running but keep in the list.",
      },
    },
    required: ["discountId", "status"],
  },
};

const deleteDiscountDeclaration: FunctionDeclaration = {
  name: "delete_discount",
  description:
    "PERMANENTLY remove an automatic discount from the store. Distinct from set_discount_status PAUSED — that keeps the discount in the list (just not running); delete_discount removes it entirely and the action cannot be undone (the merchant would have to recreate from scratch). PREFER set_discount_status PAUSED when the merchant might want to resume the offer later. REQUIRES HUMAN APPROVAL. Always call read_discounts first to find the discount's id.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      discountId: {
        type: "string",
        description: "Discount node GID. Get this from read_discounts.",
      },
    },
    required: ["discountId"],
  },
};

const PRICING_PROMOTIONS_SPEC: DepartmentSpec = {
  id: "pricing-promotions",
  label: "Pricing & Promotions",
  managerTitle: "Pricing & Promotions manager",
  description:
    "Owns prices and discounts: setting variant prices, sale-price strikethrough (compareAtPrice), bulk price changes, listing discounts, and creating automatic discounts.",
  systemPrompt: PRICING_PROMPT,
  toolDeclarations: [
    updateProductPriceDeclaration,
    createDiscountDeclaration,
    updateCompareAtPriceDeclaration,
    bulkUpdatePricesDeclaration,
    readDiscountsDeclaration,
    updateDiscountDeclaration,
    setDiscountStatusDeclaration,
    deleteDiscountDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["update_product_price", updateProductPriceHandler],
    ["create_discount", createDiscountHandler],
    ["update_compare_at_price", updateCompareAtPriceHandler],
    ["bulk_update_prices", bulkUpdatePricesHandler],
    ["read_discounts", readDiscountsHandler],
    ["update_discount", updateDiscountHandler],
    ["set_discount_status", setDiscountStatusHandler],
    ["delete_discount", deleteDiscountHandler],
  ]),
  classification: {
    read: new Set(["read_discounts"]),
    write: new Set([
      "update_product_price",
      "create_discount",
      "update_compare_at_price",
      "bulk_update_prices",
      "update_discount",
      "set_discount_status",
      "delete_discount",
    ]),
    inlineWrite: new Set(),
  },
};

registerDepartment(PRICING_PROMOTIONS_SPEC);

export { PRICING_PROMOTIONS_SPEC };
