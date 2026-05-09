import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  createArticleHandler,
  createPageHandler,
  deleteArticleHandler,
  deletePageHandler,
  readArticlesHandler,
  readPagesHandler,
  updateArticleHandler,
  updateCollectionSeoHandler,
  updatePageHandler,
  updateProductSeoHandler,
} from "./handlers";
import { loadRaw } from "../../load-raw.server";
const MARKETING_PROMPT = loadRaw("app/lib/agent/departments/marketing/prompt.md");

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

// ----------------------------------------------------------------------------
// V-Mkt-B — Blog article tools (read_articles, create_article, update_article,
// delete_article). Require read_content + write_content scopes (added to
// shopify.app.toml in Round Mkt-B). Write tools follow the standard approval
// flow; read_articles is the dept's first read tool.
// ----------------------------------------------------------------------------

const readArticlesDeclaration: FunctionDeclaration = {
  name: "read_articles",
  description:
    "List blog articles. Returns title, handle, summary, author, tags, image, published status, and timestamps for up to 50 articles. Body is omitted from list results — call this first to find the article, then propose `update_article` / `delete_article` with the article's id.\n\nFilter to a single blog with `blogId` (most stores have one default 'News' blog; multi-blog stores must specify). Filter by text with `query` (matches title / author / tags via Shopify's article search syntax). Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      blogId: {
        type: "string",
        description:
          "Optional Blog GID, e.g. gid://shopify/Blog/12345. Omit to list across all blogs (most stores have just one).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max articles to return. Defaults to 20.",
      },
      query: {
        type: "string",
        description:
          "Optional Shopify article search syntax — bare keywords match title/author/tags, or use `tag:winter` / `author:Jane` / `published_status:published` for precision.",
      },
    },
  },
};

const createArticleDeclaration: FunctionDeclaration = {
  name: "create_article",
  description:
    "Create a new blog article. **REQUIRES HUMAN APPROVAL.**\n\nUse this when the merchant asks to write a blog post, draft an article, or publish news content. The body is HTML — bring your own paragraph tags. Default `isPublished` is FALSE so the merchant can review on Shopify before going live; only pass `true` if the merchant explicitly says publish now.\n\nIf `blogId` is omitted, the article is created in the store's first/default blog (Shopify auto-creates a 'News' blog on every store). For multi-blog stores, pass the blogId explicitly — call read_articles first if you need to discover which blogs exist.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      blogId: {
        type: "string",
        description:
          "Optional Blog GID. Omit to use the store's default blog.",
      },
      title: {
        type: "string",
        description: "Article title. 1-255 characters.",
      },
      body: {
        type: "string",
        description:
          "Article body, HTML allowed. Use <p> for paragraphs. Lead with a hook; keep paragraphs short.",
      },
      summary: {
        type: "string",
        description:
          "Optional excerpt shown in blog listings. Up to 1000 characters. Shopify auto-generates one if omitted.",
      },
      author: {
        type: "string",
        description: "Optional author name. Defaults to the store owner.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional tags for filtering and SEO. Up to 50 tags.",
      },
      imageUrl: {
        type: "string",
        description:
          "Optional featured image URL (must be publicly fetchable — Shopify downloads it).",
      },
      isPublished: {
        type: "boolean",
        description:
          "Whether to publish immediately. Defaults to FALSE — published articles are public on the storefront. Default unpublished so the merchant can review.",
      },
    },
    required: ["title", "body"],
  },
};

const updateArticleDeclaration: FunctionDeclaration = {
  name: "update_article",
  description:
    "Update an existing blog article. **REQUIRES HUMAN APPROVAL.**\n\nPartial update — only the fields you set are changed; omitted fields keep their current values. Use this for both content edits AND publish/unpublish toggles (`isPublished: true` to go live, `isPublished: false` to soft-hide).\n\nAt least one field beyond `articleId` must be provided. To clear the featured image pass `imageUrl: null` (vs omitting it, which leaves the image alone).",
  parametersJsonSchema: {
    type: "object",
    properties: {
      articleId: {
        type: "string",
        description:
          "Article GID, e.g. gid://shopify/Article/12345. Get this from a read_articles call first.",
      },
      title: { type: "string", description: "New title. 1-255 chars." },
      body: { type: "string", description: "New body (HTML allowed)." },
      summary: { type: "string", description: "New excerpt. Up to 1000 chars." },
      author: { type: "string", description: "New author name." },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Replacement tag list (NOT delta — full list replaces existing).",
      },
      imageUrl: {
        type: ["string", "null"],
        description:
          "New featured image URL. Pass null to clear the image; omit to leave alone.",
      },
      isPublished: {
        type: "boolean",
        description:
          "Publish/unpublish toggle. true = publish (goes live), false = unpublish (soft-hide).",
      },
    },
    required: ["articleId"],
  },
};

const deleteArticleDeclaration: FunctionDeclaration = {
  name: "delete_article",
  description:
    "Permanently delete a blog article. **REQUIRES HUMAN APPROVAL** AND a defensive `confirmTitle` check (must match the article's current title — case-insensitive).\n\nPrefer `update_article(isPublished: false)` for 'hide this' — that's reversible. Use `delete_article` only when the merchant explicitly says delete / remove / get rid of. The AuditLog before-state preserves the full article for recovery if the merchant changes their mind.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      articleId: {
        type: "string",
        description:
          "Article GID, e.g. gid://shopify/Article/12345. Get from read_articles.",
      },
      confirmTitle: {
        type: "string",
        description:
          "The article's current title — must match (case-insensitive trim) before delete proceeds. Pass exactly what read_articles returned for the article's title field.",
      },
    },
    required: ["articleId", "confirmTitle"],
  },
};

// ----------------------------------------------------------------------------
// V-Mkt-C — Static page tools (read_pages, create_page, update_page,
// delete_page). Same scopes as articles (read_content + write_content);
// no manifest changes required for this round.
// ----------------------------------------------------------------------------

const readPagesDeclaration: FunctionDeclaration = {
  name: "read_pages",
  description:
    "List the store's static pages (About, FAQ, Shipping Policy, Returns, Privacy, etc.). Returns title, handle, body summary, template suffix, published status, and timestamps for up to 50 pages. Body is omitted from list results — call this first to find the page, then propose `update_page` / `delete_page` with the page's id.\n\nFilter by text with `query` (matches title via Shopify's page search syntax — e.g. `title:shipping`, `published_status:published`). Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max pages to return. Defaults to 20.",
      },
      query: {
        type: "string",
        description:
          "Optional Shopify page search syntax — bare keywords match titles, or use `title:about` / `published_status:published` for precision.",
      },
    },
  },
};

const createPageDeclaration: FunctionDeclaration = {
  name: "create_page",
  description:
    "Create a new static page on the store. **REQUIRES HUMAN APPROVAL.**\n\nUse this for the merchant's static content surfaces — About, FAQ, Shipping Policy, Returns, Privacy, etc. The body is HTML. Default `isPublished` is FALSE so the page goes into Shopify admin as a draft for the merchant to review; only pass `true` when the merchant explicitly says publish.\n\n`templateSuffix` lets the merchant target a custom theme template (e.g. `templateSuffix: \"contact\"` maps to `page.contact.liquid`). Omit unless the merchant has explicitly named a custom template.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Page title (also used as the default handle). 1-255 chars.",
      },
      body: {
        type: "string",
        description:
          "Page body, HTML allowed. Use <p> for paragraphs. Pages are usually longer-form than articles — full FAQs, multi-section policies, etc. are typical.",
      },
      templateSuffix: {
        type: "string",
        description:
          "Optional theme template suffix. e.g. \"contact\" maps to page.contact.liquid. Omit unless the merchant has a specific template in mind.",
      },
      isPublished: {
        type: "boolean",
        description:
          "Whether to publish immediately. Defaults to FALSE — published pages are public. Default unpublished so the merchant can review.",
      },
    },
    required: ["title", "body"],
  },
};

const updatePageDeclaration: FunctionDeclaration = {
  name: "update_page",
  description:
    "Update an existing static page. **REQUIRES HUMAN APPROVAL.**\n\nPartial update — only the fields you set are changed. At least one field beyond `pageId` must be provided. Use `isPublished: true` to publish, `isPublished: false` to soft-hide. Pass `templateSuffix: null` to clear the theme template (Shopify falls back to page.liquid).",
  parametersJsonSchema: {
    type: "object",
    properties: {
      pageId: {
        type: "string",
        description:
          "Page GID, e.g. gid://shopify/Page/12345. Get from a read_pages call first.",
      },
      title: { type: "string", description: "New title. 1-255 chars." },
      body: { type: "string", description: "New body (HTML allowed)." },
      templateSuffix: {
        type: ["string", "null"],
        description:
          "New theme template suffix. Pass null to clear; omit to leave alone.",
      },
      isPublished: {
        type: "boolean",
        description:
          "Publish/unpublish toggle. true = publish, false = unpublish (soft-hide).",
      },
    },
    required: ["pageId"],
  },
};

const deletePageDeclaration: FunctionDeclaration = {
  name: "delete_page",
  description:
    "Permanently delete a static page. **REQUIRES HUMAN APPROVAL** AND a defensive `confirmTitle` check (must match the page's current title — case-insensitive).\n\nPrefer `update_page(isPublished: false)` for 'hide this' — that's reversible. Use `delete_page` only when the merchant explicitly says delete / remove. The AuditLog before-state preserves the full page body for recovery.\n\nBe especially careful with policy pages (Shipping, Returns, Privacy) — deleting them can break the storefront. When in doubt, propose unpublish instead and ask.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      pageId: {
        type: "string",
        description:
          "Page GID, e.g. gid://shopify/Page/12345. Get from read_pages.",
      },
      confirmTitle: {
        type: "string",
        description:
          "The page's current title — must match (case-insensitive trim) before delete proceeds. Pass exactly what read_pages returned for the title field.",
      },
    },
    required: ["pageId", "confirmTitle"],
  },
};

const MARKETING_SPEC: DepartmentSpec = {
  id: "marketing",
  label: "Marketing",
  managerTitle: "Marketing manager",
  description:
    "Owns store findability and merchant-authored content: SEO titles + meta descriptions on products and collections, blog articles, and static pages (About / FAQ / Shipping / Returns / Privacy). All writes go through human approval.",
  systemPrompt: MARKETING_PROMPT,
  toolDeclarations: [
    updateProductSeoDeclaration,
    updateCollectionSeoDeclaration,
    readArticlesDeclaration,
    createArticleDeclaration,
    updateArticleDeclaration,
    deleteArticleDeclaration,
    readPagesDeclaration,
    createPageDeclaration,
    updatePageDeclaration,
    deletePageDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["update_product_seo", updateProductSeoHandler],
    ["update_collection_seo", updateCollectionSeoHandler],
    ["read_articles", readArticlesHandler],
    ["create_article", createArticleHandler],
    ["update_article", updateArticleHandler],
    ["delete_article", deleteArticleHandler],
    ["read_pages", readPagesHandler],
    ["create_page", createPageHandler],
    ["update_page", updatePageHandler],
    ["delete_page", deletePageHandler],
  ]),
  classification: {
    read: new Set(["read_articles", "read_pages"]),
    write: new Set([
      "update_product_seo",
      "update_collection_seo",
      "create_article",
      "update_article",
      "delete_article",
      "create_page",
      "update_page",
      "delete_page",
    ]),
    inlineWrite: new Set(),
  },
};

registerDepartment(MARKETING_SPEC);

export { MARKETING_SPEC };
