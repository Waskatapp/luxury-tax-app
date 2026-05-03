import type { FunctionDeclaration } from "@google/genai";

// All 7 tool declarations Gemini may call. We use `parametersJsonSchema` so
// the schema is plain JSON Schema (the SDK's typed `parameters` field uses an
// enum-based Schema wrapper that requires more boilerplate).
//
// Write tools self-describe as "REQUIRES HUMAN APPROVAL" so Gemini explains
// the flow correctly to the merchant.
export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  // V-Sub-3 — read_products and read_collections MIGRATED to the
  // Products department (app/lib/agent/departments/products/). The CEO
  // calls delegate_to_department(department="products", task="...")
  // to invoke them.
  // V-Sub-2 — get_analytics MIGRATED to the Insights department
  // (app/lib/agent/departments/insights/). To invoke it, the CEO calls
  // delegate_to_department(department="insights", task="..."). The
  // declaration lives in the department module now.
  {
    name: "read_workflow",
    description:
      "Read the full body of a specific workflow SOP. Use this on demand when you're about to execute a task and want the detailed runbook (rules, edge cases, audit details) — the system prompt only shows you a workflow INDEX by default to keep token cost low. Worth fetching for: bulk operations, multi-step plans, edge cases you haven't seen recently. Don't pre-fetch every workflow; call it only when the SOP would actually inform your next action.\n\nValid `name` values match the workflow filenames (without `.md`) — see the workflow index in your system prompt for the exact list, e.g. `price-change`, `product-creation`, `discount-creation`. Names are kebab-case (lowercase letters, digits, hyphens, underscores), case-insensitive, no path traversal.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Workflow name from the index, e.g. `price-change`, `product-creation`, `discount-creation`. Lowercase letters, digits, hyphens, underscores. Server-side validation rejects anything else.",
        },
      },
      required: ["name"],
    },
  },
  // V-Sub-4 — update_product_price MIGRATED to the Pricing & Promotions
  // department (app/lib/agent/departments/pricing-promotions/). The CEO
  // calls delegate_to_department(department="pricing-promotions",
  // task="...") to invoke it.
  // V-Sub-3 — update_product_description, update_product_status, and
  // create_product_draft MIGRATED to the Products department. The CEO
  // delegates via delegate_to_department(department="products", ...);
  // the manager proposes the write; an ApprovalCard renders for the
  // merchant exactly like before.
  {
    name: "update_store_memory",
    description:
      "Save or update a durable fact about the merchant's store, brand, or preferences. Executes inline — NO approval card, because this only updates the Copilot's own memory, not the store. Call this when the merchant says 'remember', 'always', 'from now on', 'by default', or corrects a fact you have wrong. Use canonical snake_case keys (brand_voice, default_discount_percent, store_location) so the same key reuses (overwrites) prior values for the same concept.\n\nCategories:\n- BRAND_VOICE: how the merchant wants product copy and replies to sound (e.g. 'casual, witty, never corporate-speak').\n- PRICING_RULES: rules about how prices are set (e.g. 'all hoodies end in .99', 'never below cost+30%').\n- PRODUCT_RULES: rules about product structure (e.g. 'every product needs an SEO description ≥120 chars').\n- CUSTOMER_RULES: rules about customer-facing behavior (e.g. 'always include free-shipping note over $50').\n- STORE_CONTEXT: durable facts about the store itself (e.g. 'we ship from Vancouver', 'B2B pricing requires login').\n- OPERATOR_PREFS: the merchant's personal facts and preferences for how the Copilot should behave or address them. Examples: 'merchant_name: Sam' (their name — use it to address them), 'address_as: Sam' (preferred salutation), 'don't ask follow-up questions on weekends'. NEVER store something like 'operator_name' or 'copilot_name' as if it were the AI's name — entries here describe the merchant, never the Copilot itself. Prefer keys like `merchant_name`, `merchant_pronouns`, `prefers_short_replies` to keep the semantics obvious.\n- STRATEGIC_GUARDRAILS: load-bearing rules the Copilot must honor and warn about BEFORE violating. Use this when the merchant states a goal, principle, or absolute rule — examples: 'never apply discounts under 10%', 'always test on draft products first', 'never archive a top-5 seller without confirming'. The CEO checks every action against these and warns the merchant before doing anything that would violate them.\n\n**Goals are a special shape inside STRATEGIC_GUARDRAILS.** When the merchant states a measurable strategic objective with a target ('hit $10K MRR by June', 'lift conversion 15% by Q3', 'reposition as premium and avoid mass discounting'), store it with the `goal:active:NAME` key convention (e.g. `goal:active:revenue_q2_2026` → 'Hit $10K MRR by 2026-06-30'). When the goal is met or abandoned, the merchant or CEO renames it to `goal:dormant:NAME` so it stays in memory for context but is no longer enforced. The CEO references active goals when generating plans — every meaningful plan should align with at least one active goal, or the CEO should flag the misalignment.",
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
                  "marketing",
                  "customers",
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
        parentPlanId: {
          type: "string",
          description:
            "Optional. Set this to the id of a previously-APPROVED plan when you're proposing a REPLAN — i.e. you started executing the original plan, re-read state before a write step (per decision rule 15), and reality diverged from your draft-time assumptions (price already changed, inventory dropped, item archived, etc.). The replan summary should explain the divergence concretely: \"Revised — Cat Food was already at $19.99 by the time we executed step 2; original plan assumed $24.99\". DO NOT set this for fresh plans on a new request — only when continuing/correcting an in-flight plan.",
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
    name: "propose_followup",
    description:
      "Queue a follow-up evaluation of a meaningful change you just made (description rewrite, price change, status flip, discount). The offline evaluator runs daily — when YOUR evaluation criteria are met, it pulls before/after metrics, runs significance math, and writes an Insight that surfaces in the merchant's NEXT conversation. This is how you remember to check whether your work actually moved the needle.\n\nCall this AFTER an outcome-bearing write, in the same turn as the tool_result lands. Do NOT call it for writes that have no measurable outcome (memory updates, store-only edits, cosmetic fixes). Don't call it for read tools. Don't call it speculatively without a write.\n\n**The `evaluationCriteria` is YOUR JUDGMENT for THIS specific action — never a fixed default.** Size them based on the product's traffic, the change's magnitude, and what kind of effect you'd expect. Examples (illustrative only — pick numbers that fit the case):\n  - High-traffic SKU + meaningful copy change → `min_sessions: 200, max_days: 30`. You'll see signal fast.\n  - Slow-mover description rewrite → `min_days: 45, max_days: 90`. Sessions won't accumulate; lean on time.\n  - Hot SKU pricing change → `min_sessions: 50, max_days: 14`. Pricing reactions are fast.\n  - Store-wide discount campaign → `min_orders: 30, max_days: 21`. Orders are the right gate, not sessions.\n  - Genuinely uncertain → wider window: `min_days: 21, max_days: 60`.\n\nThe merchant has explicitly stated nothing should be static. Picking '30 days for everything' is wrong — different products and different changes deserve different windows. The CEO's per-action judgment IS the value here.\n\n`baselineSnapshot` captures the metric values at the time of the change as a JSON object — its shape depends on `metric`. For `conversion_rate`: `{ sessions, conversions, asOf }`. For `revenue`: `{ revenue, currency, asOf }`. For `units_sold`: `{ units, asOf }`. The evaluator reads this back when running the post-mortem.\n\n`hypothesis` should state what you expected and why, in one sentence: 'rewriting the warranty paragraph should lift conversion because the previous copy buried the lifetime guarantee'. The post-mortem will read this and decide whether the data supports it.\n\n`expectedDirection` is `lift` (improvement), `drop` (intentional pricing/positioning move you expect to reduce a metric), or `neutral` (you don't expect a change but want to verify).\n\nThis tool is inline — it persists the followup row and continues your turn. No approval card. The merchant only sees the result weeks later as a surfaced Insight.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        productId: {
          type: "string",
          description:
            "GID of the product under evaluation, e.g. gid://shopify/Product/12345. Optional — omit for store-wide followups (e.g. checking overall conversion).",
        },
        metric: {
          type: "string",
          enum: [
            "conversion_rate",
            "revenue",
            "sessions",
            "units_sold",
            "aov",
            "inventory_at_risk",
          ],
          description:
            "What metric this followup tracks. Match it to what the change is supposed to move.",
        },
        hypothesis: {
          type: "string",
          description:
            "One sentence: what you expected and why. The post-mortem reads this when deciding if the data supports your bet.",
        },
        expectedDirection: {
          type: "string",
          enum: ["lift", "drop", "neutral"],
          description:
            "Did you expect the metric to go up, down, or stay the same?",
        },
        expectedEffectPct: {
          type: "integer",
          description:
            "Optional confident guess of the effect size in whole percentage points, e.g. 5 for '+5% conversion' or -10 for a 10% drop. Use only when you have a real number in mind, not as filler.",
        },
        baselineSnapshot: {
          type: "object",
          description:
            "Current metric values at the time of the action. Set the field(s) that match your metric — for `conversion_rate` set `sessions` + `conversions`; for `revenue` set `revenue` + `currency`; for `units_sold` set `units`. Always set `asOf`. Other fields can be left out.",
          properties: {
            sessions: {
              type: "integer",
              description:
                "Sessions on the affected product / store during the baseline period.",
            },
            conversions: {
              type: "integer",
              description:
                "Conversions during the baseline period (orders attributed to this product or, store-wide, total orders).",
            },
            units: {
              type: "integer",
              description:
                "Units sold during the baseline period.",
            },
            orderCount: {
              type: "integer",
              description:
                "Number of orders during the baseline period.",
            },
            revenue: {
              type: "string",
              description:
                "Revenue during the baseline period as a decimal string, e.g. '1234.56'. Pass as a string to avoid float drift.",
            },
            currency: {
              type: "string",
              description:
                "ISO 4217 currency code matching the store, e.g. 'USD'.",
            },
            asOf: {
              type: "string",
              description:
                "ISO 8601 timestamp of when this snapshot was captured (typically right before/after the change).",
            },
          },
        },
        evaluationCriteria: {
          type: "object",
          description:
            "YOUR JUDGMENT for when this followup is ready to evaluate. NOT a default. At least one of min_sessions / min_days must be set; max_days is required.",
          properties: {
            min_sessions: {
              type: "integer",
              minimum: 1,
              description:
                "Wait until the affected product/store has accumulated at least this many sessions. For traffic-driven evaluation.",
            },
            min_days: {
              type: "integer",
              minimum: 1,
              maximum: 365,
              description:
                "Wait at least this many days before evaluating. For time-driven evaluation.",
            },
            max_days: {
              type: "integer",
              minimum: 1,
              maximum: 365,
              description:
                "Hard upper bound. After this many days, evaluate even if min_sessions wasn't reached (verdict will be 'insufficient_data').",
            },
            min_units: {
              type: "integer",
              minimum: 1,
              description:
                "Optional: gate on units sold instead of sessions, when transactions are the meaningful signal.",
            },
            min_orders: {
              type: "integer",
              minimum: 1,
              description:
                "Optional: gate on order count, useful for discount campaigns and high-AOV stores.",
            },
          },
          required: ["max_days"],
        },
      },
      required: [
        "metric",
        "hypothesis",
        "expectedDirection",
        "baselineSnapshot",
        "evaluationCriteria",
      ],
    },
  },
  // V-Sub-4 — create_discount MIGRATED to Pricing & Promotions.
  {
    // V-Sub-1 — Phase Sub-Agents. Meta-tool that hands a focused task to
    // a department manager (sub-agent). The manager has its own tools
    // and SOPs you don't see in your prompt — call this when the task
    // fits a specific domain. Returns a summary + any proposed writes
    // the manager wants the merchant to approve. This is the ONLY way
    // to invoke domain tools that have been migrated to a department
    // module — they no longer appear in your direct tool list.
    //
    // For phase Sub-1 only the `_pilot` department exists (smoke test).
    // Real departments (insights, products, pricing-promotions) come in
    // subsequent phases.
    name: "delegate_to_department",
    description:
      "Hand a focused task to a department manager (sub-agent). Use this when the merchant's request fits a specific domain — the manager has tools and SOPs you don't see directly. The manager runs as a separate focused turn, returns either a completed summary (for read-only work) or proposed writes (which appear as ApprovalCards in the merchant's main conversation, exactly like direct tool calls). Available departments depend on the migration phase; check the Departments section of your prompt for the current list. NEVER fabricate a department name — pass exactly the id shown there.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        department: {
          type: "string",
          description:
            "The department manager id. Must match an id listed in the Departments section of your prompt.",
        },
        task: {
          type: "string",
          description:
            "Plain-English task description, including any constraints from the merchant (e.g., 'Lower Cat Food price to $19.99 — merchant said keep margin above 30%'). Be specific; the manager doesn't see the merchant's full message.",
        },
        conversationContext: {
          type: "string",
          description:
            "Optional. A brief 1-2 sentence summary of relevant context from the merchant's main conversation (e.g., 'Merchant just rewrote the Cat Food description and wants to follow with a price cut'). Helps the manager interpret the task. Skip if unnecessary.",
        },
      },
      required: ["department", "task"],
    },
  },
];
