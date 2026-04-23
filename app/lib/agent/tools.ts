import type Anthropic from "@anthropic-ai/sdk";

// All 7 tool definitions Claude may call. Write tools describe themselves as
// "requires human approval" so Claude explains the flow correctly.
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "read_products",
    description:
      "List products in the store. Returns id, title, handle, status, product type, vendor, total inventory, and price range for each. Defaults to the first 20 products. Pass `after` (cursor from a previous page) to paginate.",
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
      "Update the price of a product variant. REQUIRES HUMAN APPROVAL — you only request the change; a merchant approval card is shown. Pass the product GID, the variant GID, and the new price as a decimal string.",
    input_schema: {
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
      "Update a product's description HTML. REQUIRES HUMAN APPROVAL.",
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
