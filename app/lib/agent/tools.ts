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
      "Search and list collections (product groupings). Returns rich data per collection: id, title, handle, products count, updatedAt, a description preview (~300 chars), sortOrder, SEO title and description, AND `rules` for smart collections (the conditions like 'tag is winter' or 'price > 50' that automatically include products). Manual (hand-curated) collections have `rules: null`.\n\nAs with read_products: pass `query` with bare keywords to do multi-field search across title, description, and metadata — that's the agentic default. Field-prefixed forms narrow: `title:winter`, `collection_type:smart`, `updated_at:>2026-01-01`. If a search returns nothing, retry with broader keywords from the merchant's phrasing before giving up. The merchant doesn't know collection IDs; they think in titles, themes, or descriptions of what's in them.\n\nUse the `rules` field to explain to the merchant WHY a product is or isn't in a smart collection (e.g. 'New Arrivals' might be `tag is new` — products without that tag won't appear).",
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
    name: "read_workflow",
    description:
      "Read the full body of a specific workflow SOP. Use this on demand when you're about to execute a task and want the detailed runbook (rules, edge cases, audit details) — the system prompt only shows you a workflow INDEX by default to keep token cost low. Worth fetching for: bulk operations, multi-step plans, edge cases you haven't seen recently. Don't pre-fetch every workflow; call it only when the SOP would actually inform your next action.\n\nValid `name` values match the workflow filenames (without `.md`) — see the workflow index in your system prompt for the exact list, e.g. `price-change`, `product-creation`, `discount-creation`. Names are kebab-case and case-insensitive.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[A-Za-z0-9_-]+$",
          description:
            "Workflow name from the index, e.g. `price-change`. Lowercase letters, digits, hyphens, underscores. No path traversal.",
        },
      },
      required: ["name"],
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
      "Save or update a durable fact about the merchant's store, brand, or preferences. Executes inline — NO approval card, because this only updates the Copilot's own memory, not the store. Call this when the merchant says 'remember', 'always', 'from now on', 'by default', or corrects a fact you have wrong. Use canonical snake_case keys (brand_voice, default_discount_percent, store_location) so the same key reuses (overwrites) prior values for the same concept.\n\nCategories:\n- BRAND_VOICE: how the merchant wants product copy and replies to sound (e.g. 'casual, witty, never corporate-speak').\n- PRICING_RULES: rules about how prices are set (e.g. 'all hoodies end in .99', 'never below cost+30%').\n- PRODUCT_RULES: rules about product structure (e.g. 'every product needs an SEO description ≥120 chars').\n- CUSTOMER_RULES: rules about customer-facing behavior (e.g. 'always include free-shipping note over $50').\n- STORE_CONTEXT: durable facts about the store itself (e.g. 'we ship from Vancouver', 'B2B pricing requires login').\n- OPERATOR_PREFS: how the merchant wants the Copilot to behave (e.g. 'don't ask follow-up questions on weekends').\n- STRATEGIC_GUARDRAILS: load-bearing rules the Copilot must honor and warn about BEFORE violating. Use this when the merchant states a goal, principle, or absolute rule — examples: 'never apply discounts under 10%', 'Q2 goal: 20% revenue growth', 'always test on draft products first', 'never archive a top-5 seller without confirming'. The CEO checks every action against these and warns the merchant before doing anything that would violate them.",
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
            "STRATEGIC_GUARDRAILS",
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
    name: "ask_clarifying_question",
    description:
      "**This is the ONLY way to ask the merchant a clarifying question.** Whenever you would otherwise type a question in your reply (\"Which product?\", \"By how much?\", \"What price?\"), call this tool instead. The merchant gets clickable option buttons + a typed-answer fallback — much faster than retyping context. Typing the question as plain prose is wrong and breaks the UX even when it feels natural.\n\nUse ONLY when intent is genuinely ambiguous AND the answer would change the action AND can't be inferred from history, store memory, or current store state. NEVER ask for product IDs, variant IDs, or currency — look those up yourself with read_products / read_collections.\n\nFormat: one short question, no preamble (no \"I can help with that — \" filler). Provide 2–4 short concrete options when the answer space is small (e.g. options: [\"The cat one\", \"The dog one\"]). Omit options entirely for genuinely free-form questions. The system pauses the turn after this call and waits for the merchant's reply, so don't combine it with other tool calls in the same turn.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The single concise question. One sentence. No preamble.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Up to 4 short answer options the merchant can click. Each ≤40 chars. Omit for free-text.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "propose_plan",
    description:
      "Propose a multi-step plan when the merchant's request needs MORE THAN ONE write tool, OR a sequence of read+write across departments (e.g. \"audit my catalog and lower any overpriced items\", \"clean up draft products and publish the ready ones\", \"prepare a 10% promo on hoodies and add a related collection\"). Call this FIRST, BEFORE any of the actual tool calls. The merchant approves the whole plan; you then execute its steps one by one, and each WRITE step still gets its own approval card.\n\n**Steps are STRATEGY-level, not item-level.** Hard cap is 8 steps — if your draft would have more, you're enumerating actions instead of describing strategy. WRONG: 28 steps each saying \"Lower price of <Product N> to $5\". RIGHT: 1 step saying \"Apply a $5 floor to the 28 items currently above $5\". The individual write tool calls still happen one at a time during execution (each with its own approval card) — the plan only needs to communicate WHAT and WHY, not enumerate every line item. If a strategy genuinely has 3–5 distinct phases (\"identify outliers, then trim, then verify\"), 3–5 steps is correct. If you're tempted to write more than 8, restructure as fewer broader steps.\n\n**REFUSE plans that would clearly destroy value at scale.** \"Lower a $2629 snowboard to $5\" is a 99.8% margin destruction; even if the merchant said \"lower all to $5\" literally, propose a percentage-based alternative or push back BEFORE calling propose_plan. \"Archive my top 5 best sellers\" is the same. Don't paraphrase a clearly-bad request into a plan and ask for approval — that's a yes-person move. The merchant can override your refusal, but the conflict has to be visible BEFORE the plan card.\n\nDO NOT use for: a single-tool action (just call the tool), a pure-read query (\"show me my products\" — just call read_products), or a clarifying question (use ask_clarifying_question). Plans are the right fit only when there are at least 2 distinct strategic steps the merchant should see together before any execute.\n\nFormat: a one-sentence summary that names the goal, then 2–8 ordered steps. Each step has a short merchant-facing description (\"Lower the 28 items above $5 to a $5 floor\"), a department id (`products` / `pricing-promotions` / `insights` / `cross-cutting` for memory updates), and optionally an `estimatedTool` name as a hint. Don't combine propose_plan with other tool calls in the same turn — the system pauses the turn after this call so the merchant can approve.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "One sentence (≤280 chars) naming the goal. Lead with the action, not preamble.",
        },
        steps: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description:
                  "Merchant-facing one-line description of what this step does. Concrete (\"Lower cat food from $25 to $19.99\"), not abstract (\"Update pricing\").",
              },
              departmentId: {
                type: "string",
                enum: [
                  "products",
                  "pricing-promotions",
                  "insights",
                  "cross-cutting",
                ],
                description:
                  "Which department owns this step. `cross-cutting` for memory-update steps that span everything.",
              },
              estimatedTool: {
                type: "string",
                description:
                  "Optional. The tool name you expect to call for this step (e.g. \"update_product_price\"). For info, not enforcement — actual tool calls happen later.",
              },
            },
            required: ["description", "departmentId"],
          },
        },
      },
      required: ["summary", "steps"],
    },
  },
  {
    name: "propose_artifact",
    description:
      "Open an editable side panel with a prose draft the merchant can review and edit BEFORE the underlying write fires. Use this INSTEAD of update_product_description when generating a NEW or REWRITTEN product description from scratch — the merchant almost always wants to tweak prose copy before it goes live, and editing inside an open canvas is much faster than asking them to dictate edits as chat replies. The panel approval flow then funnels the merchant's edited content through update_product_description with its regular AuditLog + diff, so we don't lose the existing approval guarantees.\n\nKinds (today): `description` — a product's body HTML. (More kinds may be added in later phases — discount-config, promo-copy.)\n\nDO NOT use for: short structured edits where there's no prose to draft (price, status, tags) — those go through their direct write tools. Don't use it for tiny fixes (\"capitalize the brand name\") — for a few-word change, just call update_product_description directly. Use it when you'd otherwise be writing 50+ words of new copy in chat that the merchant would need to copy-paste or dictate edits to.\n\nFormat: provide the productId GID, the human-readable productTitle (for the panel header), and the FULL draft body in `content` (HTML; use `<p>`, `<strong>`, `<ul><li>`, etc.). Don't combine with other tool calls in the same turn — the system pauses the turn after this call so the merchant can edit and approve.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["description"],
          description:
            "What kind of draft this is. Today only `description` is supported.",
        },
        productId: {
          type: "string",
          description:
            "Product GID, e.g. gid://shopify/Product/12345. Get this from read_products.",
        },
        productTitle: {
          type: "string",
          description:
            "Human-readable product title, shown in the panel header so the merchant sees which product they're editing.",
        },
        content: {
          type: "string",
          description:
            "The full HTML draft body. Will be saved as the artifact's initial content; the merchant can then edit it in the panel before approving.",
        },
      },
      required: ["kind", "productId", "productTitle", "content"],
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
