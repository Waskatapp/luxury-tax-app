# Workflows — the "W" in WAT

These markdown files are the **business-rules layer** of the Merchant Copilot.
They are owned by the merchant, not by code. Edit them in plain English to
encode how *your* store should be run.

## What lives here

One file per merchant-facing action the AI can take. Each file documents:

- **When this runs** — the kinds of merchant requests that should trigger it
- **Business rules** — guardrails the AI should follow (price floors, brand
  voice notes, sale duration limits, etc.)
- **Edge cases** — situations to watch for and how to handle them
- **What approval means** — what actually happens when you click *Approve*

## Who edits them

You (the merchant) do. These are not technical specs — they are the rules of
*your* store. If you want every discount capped at 30% and lasting at most 14
days, you add that rule to [discount-creation.md](discount-creation.md). If
your brand voice is "warm, plain-spoken, never use exclamation marks", you put
that in [product-description.md](product-description.md).

The AI loads these as constraints before acting. When you change a rule here,
the next conversation already follows the new rule.

## How they connect to the code

- **Tools** (`app/lib/shopify/*.server.ts`) — the dumb, deterministic
  Shopify-API calls. They follow the *shape* required by Shopify, not your
  business rules.
- **Agents** (`app/lib/agent/*.ts`) — the AI orchestration. They decide
  *which* tool to call and pass it the right inputs. They consult these
  workflow files for the *business rules* before deciding.
- **Workflows** (this directory) — your rules in plain English. Read by the
  agent on every relevant turn.

## Files

### Decision-tree workflows (`decide-*`)
Phase Wf Round Wf-B added these to template the reasoning the agent used to
improvise. Each one is a step-by-step branching tree the agent walks before
picking a tool.

- [decide-discount-shape.md](decide-discount-shape.md) — automatic vs. code vs. bundle
- [decide-bulk-vs-individual.md](decide-bulk-vs-individual.md) — fan out vs. ask one-by-one
- [decide-write-vs-propose-plan.md](decide-write-vs-propose-plan.md) — single write vs. multi-step plan

### Domain workflows
- [analytics.md](analytics.md) — `get_analytics` (top products, revenue)
- [discount-creation.md](discount-creation.md) — `create_discount`
- [inventory-audit.md](inventory-audit.md) — `get_analytics` (inventory at risk)
- [price-change.md](price-change.md) — `update_product_price`
- [product-creation.md](product-creation.md) — `create_product_draft`
- [product-description.md](product-description.md) — `update_product_description`
- [product-status.md](product-status.md) — `update_product_status`
- [store-memory.md](store-memory.md) — `update_store_memory` + automatic extraction

### Authoring spec
- [_FORMAT.md](_FORMAT.md) — required sections, anti-patterns table format,
  trigger conventions, naming rules. Read this before authoring a new workflow.

## How auto-trigger works (Phase Wf Round Wf-A)

Every workflow declares `triggers: [keyword, multi word phrase]` in its
frontmatter. At each chat turn, the agent loop matches the merchant's last
message (plus capped prior assistant text) against every workflow's triggers.
The top-3 matches are auto-injected into the system prompt as "Suggested
workflows for this turn"; rule 34 tells the agent to read each via
`read_workflow` BEFORE proposing a tool call.

These files are auto-loaded into the agent's system prompt at request time
(see `app/lib/agent/workflow-loader.server.ts`). When you edit a file here,
the next deploy follows the new rule.
