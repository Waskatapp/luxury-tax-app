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

> **Phase note (2026-04-25):** These workflows are written but not yet auto-
> loaded into the agent's system prompt at runtime. That wiring lands in
> Phase 6. Until then, they serve as documentation for future agent sessions
> and as the source of truth when we wire them up.

## Files

- [discount-creation.md](discount-creation.md) — `create_discount`
- [price-change.md](price-change.md) — `update_product_price`
- [product-creation.md](product-creation.md) — `create_product_draft`
- [product-description.md](product-description.md) — `update_product_description`
- [product-status.md](product-status.md) — `update_product_status`
