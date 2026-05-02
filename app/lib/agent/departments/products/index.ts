import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type {
  DepartmentSpec,
  ToolHandler,
} from "../department-spec";

import {
  createProductDraftHandler,
  duplicateProductHandler,
  readCollectionsHandler,
  readProductsHandler,
  updateProductDescriptionHandler,
  updateProductStatusHandler,
  updateProductTagsHandler,
  updateProductTitleHandler,
  updateProductTypeHandler,
  updateProductVendorHandler,
  updateVariantHandler,
} from "./handlers";
import PRODUCTS_PROMPT from "./prompt.md?raw";

// V-Sub-3 — Phase Sub-Agents Products department. Owns the product
// catalog: searching products and collections, rewriting descriptions,
// changing status, and creating new draft products. 5 tools, mix of
// 2 reads + 3 writes. The largest department migration; validates the
// proposed-writes integration in api.chat.tsx end-to-end.
//
// Tool declarations are copied verbatim from the central tools.ts so
// merchant-facing tool behavior is unchanged. The CEO no longer sees
// these directly; it must call delegate_to_department(department=
// "products", task=...) to invoke them. The Products manager (sub-
// agent) loads only this department's tool list into its focused turn.

const readProductsDeclaration: FunctionDeclaration = {
  name: "read_products",
  description:
    "Search and list products. Returns rich data per product: id, title, handle, status, product type, vendor, tags, a description preview (~400 chars), SEO title and SEO description, total inventory, price range, AND a `variants` array (up to 10 per product) where each variant has its own id, title, price, sku, and inventoryQuantity. Use this data to match the merchant's intent — they may misspell, abbreviate, describe a product by what it does, or use a partial/old name. The merchant doesn't know Shopify product IDs; they think in product titles, descriptions, and categories.\n\nThe `query` parameter is a Shopify search string; passing bare keywords (no `field:` prefix) does a multi-field search across title, description, vendor, tags, and product type — that's the right default for matching by name or topic. Use `field:value` only when you specifically want to narrow to one field (e.g. `vendor:Hydrogen`, `status:active`). Combine with spaces (AND): `snowboard status:active`.\n\nIntelligent matching: if a search returns nothing, try alternatives — fewer or different keywords, the singular form, a category word from the merchant's phrasing. Inspect the description and tags of results to confirm it's the right product before acting; titles alone can be ambiguous in stores with many similar products. Without `query` you only get the first 20 alphabetical products, which will miss most matches.\n\n**Use the `variants[].id` from this response when proposing variant-level writes (price changes happen in Pricing & Promotions; you'd reference the variant id in your handoff to the CEO). NEVER fabricate variant IDs — if a product's `variants` array is empty, that means it has none in the first 10 (rare) and you should tell the CEO rather than guess.**",
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
};

const readCollectionsDeclaration: FunctionDeclaration = {
  name: "read_collections",
  description:
    "Search and list collections (product groupings). Returns rich data per collection: id, title, handle, products count, updatedAt, a description preview (~300 chars), sortOrder, SEO title and description, AND `rules` for smart collections (the conditions like 'tag is winter' or 'price > 50' that automatically include products). Manual (hand-curated) collections have `rules: null`.\n\nAs with read_products: pass `query` with bare keywords to do multi-field search across title, description, and metadata — that's the agentic default. Field-prefixed forms narrow: `title:winter`, `collection_type:smart`, `updated_at:>2026-01-01`. If a search returns nothing, retry with broader keywords from the merchant's phrasing before giving up. The merchant doesn't know collection IDs; they think in titles, themes, or descriptions of what's in them.\n\nUse the `rules` field to explain WHY a product is or isn't in a smart collection (e.g. 'New Arrivals' might be `tag is new` — products without that tag won't appear).",
  parametersJsonSchema: {
    type: "object",
    properties: {
      first: { type: "integer", minimum: 1, maximum: 50 },
      after: { type: "string" },
      query: {
        type: "string",
        description:
          "Shopify search query. Bare keywords search across title, description, and tags — use for general lookup. Examples: `winter`, `sale`, `new arrivals`. Field forms: `title:winter`, `collection_type:smart`, `collection_type:custom`. If nothing matches, retry with a different keyword.",
      },
    },
  },
};

const updateProductDescriptionDeclaration: FunctionDeclaration = {
  name: "update_product_description",
  description:
    "Update a product's description HTML. REQUIRES HUMAN APPROVAL — you only PROPOSE the change; an approval card is shown to the merchant in the main conversation and the CEO continues only after they approve. Never claim the change has been made before approval.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: { type: "string" },
      descriptionHtml: { type: "string" },
    },
    required: ["productId", "descriptionHtml"],
  },
};

const updateProductStatusDeclaration: FunctionDeclaration = {
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
};

const createProductDraftDeclaration: FunctionDeclaration = {
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
};

const updateProductTitleDeclaration: FunctionDeclaration = {
  name: "update_product_title",
  description:
    "Rename a product (changes the product's title — the human-readable name shoppers see). REQUIRES HUMAN APPROVAL. The handle (URL slug) is NOT changed by this tool — Shopify keeps the existing handle so existing storefront links keep working.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product GID, e.g. gid://shopify/Product/12345",
      },
      title: {
        type: "string",
        description: "The new product title. 1-255 chars.",
      },
    },
    required: ["productId", "title"],
  },
};

const updateProductTagsDeclaration: FunctionDeclaration = {
  name: "update_product_tags",
  description:
    "Set the FULL list of tags on a product. This REPLACES all existing tags with the array you pass — it is not an additive operation. To add or remove individual tags, you MUST first call read_products to get the current `tags` array, compute the new list (current + added, or current minus removed), then call this tool with the full final list. REQUIRES HUMAN APPROVAL. Tags drive collections, search, and storefront filters — changing them can affect what's visible to shoppers.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product GID, e.g. gid://shopify/Product/12345",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "The complete new tag list (replaces existing). Each tag is 1-255 chars; max 250 tags per product.",
      },
    },
    required: ["productId", "tags"],
  },
};

const updateProductVendorDeclaration: FunctionDeclaration = {
  name: "update_product_vendor",
  description:
    "Set the vendor (manufacturer / brand) on a product. REQUIRES HUMAN APPROVAL. Vendor often appears on the product page and powers vendor-based collection rules.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product GID, e.g. gid://shopify/Product/12345",
      },
      vendor: {
        type: "string",
        description: "The new vendor name. 1-255 chars.",
      },
    },
    required: ["productId", "vendor"],
  },
};

const updateProductTypeDeclaration: FunctionDeclaration = {
  name: "update_product_type",
  description:
    "Set the product type (the category Shopify uses to group similar items, e.g. 'T-Shirt', 'Pet Food', 'Snowboard'). REQUIRES HUMAN APPROVAL. Product type powers type-based collection rules and helps shoppers filter the catalog.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product GID, e.g. gid://shopify/Product/12345",
      },
      productType: {
        type: "string",
        description: "The new product type. 1-255 chars.",
      },
    },
    required: ["productId", "productType"],
  },
};

const updateVariantDeclaration: FunctionDeclaration = {
  name: "update_variant",
  description:
    "Update inventory and shipping fields on a single product variant: SKU, barcode, weight (with unit), inventory policy (DENY = stop selling at zero, CONTINUE = oversell), requiresShipping, and taxable. Pass at least one of the optional fields. Price and compareAtPrice are NOT here — those live in the Pricing & Promotions department. REQUIRES HUMAN APPROVAL. Always call read_products first to find the variant and confirm the current values before proposing changes.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "Product GID. Required by Shopify's productVariantsBulkUpdate.",
      },
      variantId: {
        type: "string",
        description: "Variant GID, e.g. gid://shopify/ProductVariant/12345",
      },
      sku: { type: "string", description: "New SKU (1-255 chars)." },
      barcode: { type: "string", description: "New barcode (UPC/EAN/ISBN)." },
      weight: {
        type: "number",
        description: "New weight value (must be paired with weightUnit).",
      },
      weightUnit: {
        type: "string",
        enum: ["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"],
        description: "Weight unit (must be paired with weight).",
      },
      inventoryPolicy: {
        type: "string",
        enum: ["DENY", "CONTINUE"],
        description:
          "DENY = stop selling when inventory hits 0 (default for most stores). CONTINUE = allow overselling (useful for made-to-order or pre-order).",
      },
      requiresShipping: {
        type: "boolean",
        description:
          "Whether this variant ships physically. Set false for digital goods, services, gift cards, etc.",
      },
      taxable: {
        type: "boolean",
        description: "Whether this variant is subject to tax.",
      },
    },
    required: ["productId", "variantId"],
  },
};

const duplicateProductDeclaration: FunctionDeclaration = {
  name: "duplicate_product",
  description:
    "Duplicate an existing product into a new product. The new product gets a new title (you provide it) and a new status (DRAFT by default). Images can be optionally copied (default: yes). Variants are always copied. Use this when the merchant wants to create a similar product without typing every field again — e.g. 'duplicate Cat Food as Cat Food XL'. REQUIRES HUMAN APPROVAL. The duplicate appears in DRAFT status by default so the merchant can tweak it before publishing.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "GID of the SOURCE product (the one being duplicated).",
      },
      newTitle: {
        type: "string",
        description: "Title for the new product. 1-255 chars.",
      },
      newStatus: {
        type: "string",
        enum: ["DRAFT", "ACTIVE", "ARCHIVED"],
        description:
          "Status for the new product. Default DRAFT. Use ACTIVE only if the merchant explicitly wants the duplicate live immediately — usually they want to review first, so DRAFT is the safe default.",
      },
      includeImages: {
        type: "boolean",
        description: "Copy the source product's images. Default: true.",
      },
    },
    required: ["productId", "newTitle"],
  },
};

const PRODUCTS_SPEC: DepartmentSpec = {
  id: "products",
  label: "Products",
  managerTitle: "Products manager",
  description:
    "Owns the product catalog: searching products and collections, rewriting descriptions, renaming products, managing tags/vendor/product type, changing status (DRAFT/ACTIVE/ARCHIVED), and creating new draft products.",
  systemPrompt: PRODUCTS_PROMPT,
  toolDeclarations: [
    readProductsDeclaration,
    readCollectionsDeclaration,
    updateProductDescriptionDeclaration,
    updateProductStatusDeclaration,
    createProductDraftDeclaration,
    updateProductTitleDeclaration,
    updateProductTagsDeclaration,
    updateProductVendorDeclaration,
    updateProductTypeDeclaration,
    updateVariantDeclaration,
    duplicateProductDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_products", readProductsHandler],
    ["read_collections", readCollectionsHandler],
    ["update_product_description", updateProductDescriptionHandler],
    ["update_product_status", updateProductStatusHandler],
    ["create_product_draft", createProductDraftHandler],
    ["update_product_title", updateProductTitleHandler],
    ["update_product_tags", updateProductTagsHandler],
    ["update_product_vendor", updateProductVendorHandler],
    ["update_product_type", updateProductTypeHandler],
    ["update_variant", updateVariantHandler],
    ["duplicate_product", duplicateProductHandler],
  ]),
  classification: {
    read: new Set(["read_products", "read_collections"]),
    write: new Set([
      "update_product_description",
      "update_product_status",
      "create_product_draft",
      "update_product_title",
      "update_product_tags",
      "update_product_vendor",
      "update_product_type",
      "update_variant",
      "duplicate_product",
    ]),
    inlineWrite: new Set(),
  },
};

registerDepartment(PRODUCTS_SPEC);

export { PRODUCTS_SPEC };
