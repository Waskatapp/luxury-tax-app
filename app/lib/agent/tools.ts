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
      "Search and list products. Returns rich data per product: id, title, handle, status, product type, vendor, tags, a description preview (~400 chars), SEO title and SEO description, total inventory, price range, AND a `variants` array (up to 10 per product) where each variant has its own id, title, price, sku, and inventoryQuantity. Use this data to match the merchant's intent — they may misspell, abbreviate, describe a product by what it does, or use a partial/old name. The merchant doesn't know Shopify product IDs; they think in product titles, descriptions, and categories.\n\nThe `query` parameter is a Shopify search string; passing bare keywords (no `field:` prefix) does a multi-field search across title, description, vendor, tags, and product type — that's the right default for matching by name or topic. Use `field:value` only when you specifically want to narrow to one field (e.g. `vendor:Hydrogen`, `status:active`). Combine with spaces (AND): `snowboard status:active`.\n\nIntelligent matching: if a search returns nothing, try alternatives — fewer or different keywords, the singular form, a category word from the merchant's phrasing. Inspect the description and tags of results to confirm it's the right product before acting; titles alone can be ambiguous in stores with many similar products. Without `query` you only get the first 20 alphabetical products, which will miss most matches.\n\n**For write tools that need a variant ID (update_product_price): use the `variants[].id` from this response. NEVER fabricate variant IDs — if a product's `variants` array is empty, that means it has none in the first 10 (rare) and you should tell the merchant rather than guess.**",
    parametersJsonSchema: {
      type: "object",
      properties: {
        first: { type: "integer", minimum: 1, maximum: 50 },
        after: { type: "string" },
        query: {
          type: "string",
          description:
            "Shopify search query. Bare keywords (no prefix) search across title, description, vendor, tags, and product type — use this for general lookup. Examples: `snowboard liquid`, `cat food`, `winter gear`. Field-prefixed forms narrow the search: `title:Liquid`, `vendor:Hydrogen`, `status:active`, `tag:limited`. If a search returns nothing, retry with a broader or different keyword from the merchant's phrasing before giving up.",
        },
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
      "Sales and inventory analytics. Three metrics: `top_products` returns the top 5 best-selling products by units sold across orders in the last `days` days — use this when the merchant asks for 'top sellers', 'best sellers', 'top N products', or 'most sold' (NOT for plain 'list my products' — that's read_products); `revenue` sums order totals over the last `days` days (default 30, max 365); `inventory_at_risk` returns variants with inventory below `threshold` (default 5). Read-only — no approval card.",
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
    name: "update_store_memory",
    description:
      "Save or update a durable fact about the merchant's store, brand, or preferences. Executes inline — NO approval card, because this only updates the Copilot's own memory, not the store. Call this when the merchant says 'remember', 'always', 'from now on', 'by default', or corrects a fact you have wrong. Use canonical snake_case keys (brand_voice, default_discount_percent, store_location) so the same key reuses (overwrites) prior values for the same concept.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "BRAND_VOICE",
            "PRICING_RULES",
            "PRODUCT_RULES",
            "CUSTOMER_RULES",
            "STORE_CONTEXT",
            "OPERATOR_PREFS",
          ],
        },
        key: {
          type: "string",
          description: "Canonical snake_case key, e.g. 'brand_voice'.",
        },
        value: {
          type: "string",
          description: "Short declarative fact, under 500 characters.",
        },
      },
      required: ["category", "key", "value"],
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
