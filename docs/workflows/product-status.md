---
department: products
summary: Changing a product's lifecycle status — DRAFT / ACTIVE / ARCHIVED
triggers: [archive, archive product, publish, unpublish, draft, active, hide product]
priority: 6
---

# Workflow: Changing a product's lifecycle status

Tool: `update_product_status`

## When this runs

The merchant says things like:
- "Publish the dog washer" / "make it active" / "make it live" → **ACTIVE**
- "Unpublish this product" / "hide it" / "move back to draft" → **DRAFT**
- "Archive this old product" / "retire this" → **ARCHIVED**

## The three statuses

| Status | What it means for shoppers | What it means for you |
| --- | --- | --- |
| `DRAFT` | Hidden from storefront and search | Editable; not yet ready to sell |
| `ACTIVE` | Visible on storefront, can be bought | Live and selling |
| `ARCHIVED` | Hidden from storefront and most admin lists | Retired but kept for history |

## Business rules (defaults — edit to match your store)

1. **DRAFT → ACTIVE always requires a beat.** Even with merchant
   approval, this is the moment a product becomes purchasable. Confirm
   the price, description, and inventory are set the way the merchant
   wants *before* approving.
2. **No silent re-publishing of ARCHIVED products.** When the merchant
   asks to set an ARCHIVED product back to ACTIVE, mention that the
   product was archived (it likely was for a reason) and confirm.
3. **Already in target status: no-op.** Don't propose a tool call when
   the current status matches the requested one. Tell the merchant.
4. **DRAFT and ARCHIVED are interchangeable for hiding.** If the
   merchant just says "hide this", default to DRAFT (it implies
   "I'm working on it") rather than ARCHIVED ("I'm done with it").

## Edge cases

- **Multiple products with the same name:** disambiguate via
  `read_products` before assuming which one to act on.
- **Going from ACTIVE → DRAFT mid-sale:** warn the merchant if there
  are any pending orders or active discounts that reference the
  product (Phase 6 will fetch this; for now, mention the risk).
- **Bulk status change:** "archive all my old t-shirts" is a Phase 6
  feature. For now, do them one at a time.

## What approval means

Clicking **Approve**:
- → ACTIVE: product is visible on the storefront within seconds
- → DRAFT: product disappears from the storefront, stays in admin
- → ARCHIVED: product disappears from storefront and most admin lists

Clicking **Reject** leaves the product's status unchanged.

## Audit trail

- `before`: product id, title, current status
- `after`: product id, title, new status
