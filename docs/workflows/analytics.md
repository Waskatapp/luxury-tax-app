# Workflow: Sales analytics

Tool: `get_analytics`

## When this runs

The merchant says things like:
- "How are sales this month?"
- "What's my best seller?" / "Top products"
- "Revenue last 30 days"
- "How much did I make this week?"
- "Which products are running low?" → see [inventory-audit.md](inventory-audit.md)

## Three metrics this tool supports

| `metric` value | Question it answers |
| --- | --- |
| `top_products` | What are my best-selling products? (sorted by Shopify's BEST_SELLING ranking) |
| `revenue` | How much money did the store take in over the last N days? |
| `inventory_at_risk` | Which variants are running low? — see [inventory-audit.md](inventory-audit.md) |

## Business rules

1. **Default time window: 30 days.** If the merchant doesn't specify, assume
   "the last 30 days." Confirm before showing very different windows
   ("this year" → 365 days).
2. **`top_products` returns top 5 by default.** Cap at 20 to keep replies
   readable. The ranking is Shopify's `BEST_SELLING` sort, which is a
   recency-weighted velocity score — not a strict 30-day count.
3. **`revenue` aggregates `totalPriceSet.shopMoney` from orders.** It
   includes shipping and taxes (i.e., what the customer paid). Refunds are
   *not* subtracted in v1 — call this out if the merchant asks for "net
   revenue".
4. **Lead with the headline number, then context.** "You made $4,210 in the
   last 30 days across 38 orders." Don't bury the number under setup.
5. **No write actions follow analytics in this workflow.** If the merchant
   says "raise the price of my top product 10%", that's a separate
   `update_product_price` call with its own approval card.

## Edge cases

- **Zero orders in the window:** say so plainly ("no orders in the last 30
  days") rather than returning $0 with no context.
- **Currency mismatch:** if the store has multiple currencies, surface
  the presentment currency from the first order and note it.
- **Pagination cap:** for `revenue`, we read up to 250 orders per call. If
  the store had more than 250 orders in the window, mention the cap and
  suggest a shorter window.

## What approval means

Read-only — no approval card. Results stream directly into chat. Phase 9
will render `top_products` and `revenue` as Polaris DataTables instead of
plain text.

## Audit trail

Read-only tools don't write to AuditLog.
