import type { FunctionDeclaration } from "@google/genai";

// All 7 tool declarations Gemini may call. We use `parametersJsonSchema` so
// the schema is plain JSON Schema (the SDK's typed `parameters` field uses an
// enum-based Schema wrapper that requires more boilerplate).
//
// Write tools self-describe as "REQUIRES HUMAN APPROVAL" so Gemini explains
// the flow correctly to the merchant.
export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "read_products",
    description:
      "List products in the store. Returns id, title, handle, status, product type, vendor, total inventory, and price range for each. Defaults to the first 20 products. Pass `after` (cursor from a previous page) to paginate.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        first: { type: "integer", minimum: 1, maximum: 50 },
        after: { type: "string" },
      },
    },
  },
  {
    name: "read_collections",
    description:
      "List collections (product groupings) in the store. Not yet implemented; returns an error until Phase 6.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        first: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "get_analytics",
    description:
      "Sales analytics: top products, revenue over a period, or inventory at risk of stocking out. Not yet implemented; returns an error until Phase 9.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["top_products", "revenue", "inventory_at_risk"],
        },
        days: { type: "integer", minimum: 1, maximum: 90 },
      },
      required: ["metric"],
    },
  },
  {
    name: "update_product_price",
    description:
      "Update the price of a product variant. REQUIRES HUMAN APPROVAL — you only request the change; an approval card is shown to the merchant. Never claim you have made the change before the approval result arrives.",
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
  },
  {
    name: "update_product_description",
    description:
      "Update a product's description HTML. REQUIRES HUMAN APPROVAL — you only request the change.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        descriptionHtml: { type: "string" },
      },
      required: ["productId", "descriptionHtml"],
    },
  },
  {
    name: "create_product_draft",
    description:
      "Create a new product in DRAFT status so the merchant can review before publishing. REQUIRES HUMAN APPROVAL.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        descriptionHtml: { type: "string" },
        vendor: { type: "string" },
        productType: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
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
  },
];
