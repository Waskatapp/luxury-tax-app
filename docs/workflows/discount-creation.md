---
department: pricing-promotions
summary: Creating a percentage-off automatic discount with title, percent, dates
---

# Workflow: Creating a discount

Tool: `create_discount`

## When this runs

The merchant says things like:
- "Create a 10% off discount"
- "Make a sale called 'spring deals'"
- "Run a 15% promo from today through Friday"
- "Discount everything by 20% for the weekend"

## Business rules (defaults — edit to match your store)

1. **Use automatic discounts**, not code-based ones. Automatic discounts
   apply at checkout without the customer typing anything. v1 does not
   support code-based discounts.
2. **Site-wide only.** v1 applies the discount to all products. Collection-
   or product-scoped discounts land in Phase 6.
3. **Default duration cap: 30 days.** If the merchant asks for longer, ask
   them to confirm explicitly.
4. **Percent range: 5%–50%** without explicit confirmation. Lower than 5%
   isn't worth surfacing; higher than 50% eats margin too aggressively.
5. **Don't run two automatic discounts at the same time** without telling
   the merchant. Shopify allows it, but it usually means the merchant
   forgot about an active one.
6. **Always resolve relative dates** ("today", "next Friday", "end of the
   month") to ISO-8601 using the current date in the system prompt.

## Edge cases

- **Start date in the past:** reject and ask for a new start date.
- **End date before start date:** reject.
- **Currency:** percent-off is currency-agnostic; no conversion needed.
- **"Take $5 off":** v1 does not support fixed-amount discounts, only
  percent. Tell the merchant and offer the closest percentage.

## What approval means

Clicking **Approve** creates the discount as **ACTIVE** immediately —
shoppers see the price drop on their next visit. There is no "scheduled
draft" state; the start date controls when it activates.

Clicking **Reject** does nothing in Shopify; the audit log captures that
the merchant declined.

## Audit trail

- `before`: null (nothing existed before)
- `after`: the created discount's id, title, percent, start, end, status
