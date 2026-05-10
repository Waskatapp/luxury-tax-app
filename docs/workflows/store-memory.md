---
department: cross-cutting
summary: When and how to save durable facts about the merchant's store, brand, rules
triggers: [remember this, remember that, save this rule, brand voice, store rule]
priority: 4
---

# Store memory

## What it is

The Copilot has a long-term memory per store. Durable facts about the merchant's
brand, pricing strategy, customer rules, and operator preferences are stored in
a database table and injected into the Copilot's system instructions on every
new conversation. So if the merchant says "we always write descriptions in a
casual tone" once, the Copilot remembers that next week.

## Two ways memory gets written

1. **Automatic extraction (default).** After each conversation turn, a
   lightweight Gemini Flash-Lite call reads the merchant's message and the
   Copilot's reply, and extracts any durable facts it finds. This happens in
   the background — the merchant doesn't see it.

2. **Explicit `update_store_memory` tool.** When the merchant says "remember
   that..." or "always do X" and you (the Copilot) want to be sure it sticks,
   call `update_store_memory` directly. This is an inline-execute write — it
   does NOT show an approval card, because changing the Copilot's memory
   doesn't mutate the store.

## When to call `update_store_memory` directly

Call it when:
- The merchant says "remember", "always", "from now on", "by default", or
  "going forward" + a rule.
- The merchant corrects a fact you have wrong ("no, our brand is formal, not
  casual" → upsert with the new value).
- The merchant asks you to forget something — call it with an empty `value`
  for the relevant key, then explain that you'll route around it. (For real
  deletion, point them at /app/settings/memory.)

Do NOT call it for:
- Transient requests ("change the price of X to $19.99" — that's a write tool).
- Questions ("what's my best seller" — that's a read tool).
- Repeating something already in memory.

## Categories

- `BRAND_VOICE` — tone, voice, language style
- `PRICING_RULES` — discount caps, pricing strategy, currency rules
- `PRODUCT_RULES` — naming conventions, description format, vendor rules
- `CUSTOMER_RULES` — customer-facing communication rules
- `STORE_CONTEXT` — about the store itself ("coffee roaster in Toronto")
- `OPERATOR_PREFS` — how the merchant likes to work with the Copilot

## Keys

Use canonical snake_case keys. The same `key` upserts (overwrites) the prior
value for that store, so picking stable keys matters. Examples:

- `brand_voice` (not `tone_of_voice` or `voice_style`)
- `default_discount_percent`
- `store_location`
- `default_product_vendor`

## How the merchant manages memory

The merchant can view, edit, and delete entries at `/app/settings/memory`.
That UI is the source of truth — if they delete an entry, it's gone, and the
Copilot will not see it on the next conversation.
