import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  updateCollectionSeoHandler,
  updateProductSeoHandler,
} from "./handlers";
import MARKETING_PROMPT from "./prompt.md?raw";

// V-Mkt-A — Phase Marketing Round A. First new department since the
// sub-agent architecture stabilized in Phase Sub-Agents (2026-05-02).
// Today owns 2 SEO writes; Round B adds blog articles, Round C adds
// static pages. Both writes use the existing `write_products` scope —
// no manifest changes for Round A.

const updateProductSeoDeclaration: FunctionDeclaration = {
  name: "update_product_seo",
  description:
    "Set the SEO title and/or meta description on a single product. These are the strings Google shows in search results — distinct from the product's display title and description on the storefront. **REQUIRES HUMAN APPROVAL.**\n\nProvide at least one of `seoTitle` / `seoDescription`. Omit a field to leave it unchanged. Pass an empty string `\"\"` to CLEAR a field (Shopify falls back to the product title / description).\n\nGoogle truncates titles around 70 chars and descriptions around 160 chars — write to fit those limits. Lead with the strongest keyword.\n\nUse this when the merchant asks: 'improve the SEO for X', 'update the meta description on X', 'fix the search-result title for X'.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description:
          "Product GID, e.g. gid://shopify/Product/12345. Get this from a Products delegation first — never fabricate.",
      },
      seoTitle: {
        type: "string",
        description:
          "New SEO title. Aim for ≤ 70 chars (Google truncates beyond that). Empty string clears it (falls back to product title).",
      },
      seoDescription: {
        type: "string",
        description:
          "New SEO meta description. Aim for ≤ 160 chars (Google truncates beyond that). Empty string clears it (falls back to product description).",
      },
    },
    required: ["productId"],
  },
};

const updateCollectionSeoDeclaration: FunctionDeclaration = {
  name: "update_collection_seo",
  description:
    "Set the SEO title and/or meta description on a collection. Same semantics as `update_product_seo` but targets a collection page rather than a product page. **REQUIRES HUMAN APPROVAL.**\n\nUse this when the merchant asks about SEO on a category page (\"Cats collection\", \"Sale collection\") rather than a product.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      collectionId: {
        type: "string",
        description:
          "Collection GID, e.g. gid://shopify/Collection/12345. Get this from a Products delegation (read_collections) first — never fabricate.",
      },
      seoTitle: {
        type: "string",
        description:
          "New SEO title. Aim for ≤ 70 chars. Empty string clears it.",
      },
      seoDescription: {
        type: "string",
        description:
          "New SEO meta description. Aim for ≤ 160 chars. Empty string clears it.",
      },
    },
    required: ["collectionId"],
  },
};

const MARKETING_SPEC: DepartmentSpec = {
  id: "marketing",
  label: "Marketing",
  managerTitle: "Marketing manager",
  description:
    "Owns store findability and merchant-authored content: SEO titles + meta descriptions on products and collections. Future rounds add blog articles and static pages. All writes go through human approval.",
  systemPrompt: MARKETING_PROMPT,
  toolDeclarations: [
    updateProductSeoDeclaration,
    updateCollectionSeoDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["update_product_seo", updateProductSeoHandler],
    ["update_collection_seo", updateCollectionSeoHandler],
  ]),
  classification: {
    read: new Set(),
    write: new Set(["update_product_seo", "update_collection_seo"]),
    inlineWrite: new Set(),
  },
};

registerDepartment(MARKETING_SPEC);

export { MARKETING_SPEC };
