---
department: products
summary: Inventory audit — flagging variants below a stock threshold
triggers: [inventory audit, low stock, stock level, out of stock, restock]
priority: 5
---

# Workflow: Inventory audit & at-risk reporting

Tool: `get_analytics` with `metric: "inventory_at_risk"`

## When this runs

The merchant says things like:
- "What's running low?"
- "What am I about to run out of?"
- "Show me low-stock items"
- "Inventory report" / "What's at risk?"

## What this tool returns

A list of product variants with `inventoryQuantity` below a threshold
(default: 5). Each row includes:
- product title + variant title
- current inventory quantity
- product status (so the merchant can ignore DRAFT/ARCHIVED if they want)

Shoppers can buy as long as `inventory_policy = CONTINUE` even when
quantity is 0; this report uses raw quantity so it surfaces both
true-stockouts and policy-overridden ones.

## Business rules (defaults — edit to taste)

1. **Default threshold = 5 units.** Any variant with `inventoryQuantity < 5`
   is "at risk." Merchant can ask for a different threshold:
   "show me anything under 10".
2. **Sort: lowest quantity first.** Out-of-stock items (0 or negative)
   appear at the top — those are the urgent ones.
3. **Cap result at 50 variants.** If there are more, tell the merchant
   "you have 73 variants under 5 units; here are the most at-risk 50"
   so the conversation stays readable.
4. **Don't propose any write actions in this workflow.** This is a
   read-only audit. If the merchant says "restock all of these", that's
   a separate flow that doesn't exist yet (v2 — needs PO / supplier
   integration).

## Edge cases

- **Store doesn't track inventory** (digital products etc.):
  `inventoryQuantity` is `null`. Filter those out — they don't run out.
- **Negative quantity:** Shopify allows oversold inventory. Treat
  negative numbers as more-urgent-than-zero and surface them with a
  warning.
- **Threshold of 0:** valid — surfaces only true stockouts.

## Anti-patterns

| Don't | Do instead |
|---|---|
| Skip variants where `inventoryQuantity` is null. | Filter them BEFORE counting; null = untracked, not 0. |
| List every untracked variant ("inventory is null!" 100 times). | Don't enumerate untracked items in an at-risk report — that's noise. |
| Surface a 73-row list inline. | Cap at 50; tell the merchant the residual count. |
| Treat negative quantity as 0. | Show negative numbers verbatim — they're MORE urgent than 0 (already oversold). |
| Pair an audit with a silent "restock all" write. | Audit is read-only. Restocking is a separate write — propose explicitly. |

## What approval means

This is a **read-only** tool — no approval card. Results stream straight
into the chat as a list (Phase 9 will render them as a Polaris DataTable).

## Audit trail

Read-only tools don't write to AuditLog.
