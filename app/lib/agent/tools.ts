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
      "List collections (product groupings) in the store. Returns id, title, handle, productsCount, and updatedAt for each. Defaults to the first 20.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        first: { type: "integer", minimum: 1, maximum: 50 },
        after: { type: "string" },
      },
    },
  },
  {
    name: "get_analytics",
    description:
      "Sales and inventory analytics. Three metrics: `top_products` returns the 5 best-selling products (Shopify's BEST_SELLING sort); `revenue` sums order totals over the last `days` days (default 30, max 365); `inventory_at_risk` returns variants with inventory below `threshold` (default 5). Read-only — no approval card. Use this for sales questions, low-stock audits, and 'how am I doing' questions.",
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
          description: "Lookback window in days. Defaults to 30. Used by `revenue`; ignored by `inventory_at_risk`.",
        },
        threshold: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
          description: "Inventory threshold for `inventory_at_risk`. Variants with quantity below this are flagged. Defaults to 5.",
        },
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
    name: "update_product_status",
    description:
      "Change a product's lifecycle status. Use ACTIVE to publish a draft so shoppers can buy it; DRAFT to unpublish; ARCHIVED to retire an old product. When the merchant says \"publish it\", \"make it active\", \"make it live\", or \"archive this\", call this tool. REQUIRES HUMAN APPROVAL — moving a product to ACTIVE makes it visible on the storefront.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        productId: {
          type: "string",
          description: "Product GID, e.g. gid://shopify/Product/12345",
        },
        status: {
          type: "string",
          enum: ["DRAFT", "ACTIVE", "ARCHIVED"],
        },
      },
      required: ["productId", "status"],
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
