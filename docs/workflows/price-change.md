# Workflow: Changing a product's price

Tool: `update_product_price`

## When this runs

The merchant says things like:
- "Lower the price of the dog washer to $19.99"
- "Make this $25"
- "Bump my hoodies up to $45"
- "Drop the price on X by 10%"

## Business rules (defaults — edit to match your store)

1. **Look up the product by name; never ask the merchant for an ID.** When
   the merchant names a product, call `read_products` and find it. If
   exactly one product matches and it has exactly one variant, use that
   variant directly. If multiple products match the name, list them and
   ask which one. If a single product has multiple variants (size, color,
   etc.), list the variants and ask which one.
2. **Confirm large swings.** If the proposed price is more than 50% above
   or below the current price, ask the merchant to confirm before showing
   the approval card.
3. **Two-decimal precision.** Don't propose `$19.999` — round to two
   decimals (`19.99`).
4. **Currency stays the same.** Don't convert currencies. The variant's
   existing currency is the only one we touch.
5. **No negative or zero prices** unless the merchant explicitly says
   "make this free" — and even then, confirm.

## Edge cases

- **Merchant gave a name, not an ID:** this is the normal case — call
  `read_products` and find the match yourself. Do NOT ask the merchant
  for the product/variant ID. If the merchant later says "no, just do it,
  use the name," it means: stop asking and pick the unique match.
- **New price equals current price:** no-op. Tell the merchant the price
  is already that and skip the approval card.
- **Bulk price change** ("raise everything 10%"): not supported in v1.
  Tell the merchant to do it one product at a time, or wait for Phase 6
  bulk tools.

## What approval means

Clicking **Approve** updates the variant's price live — shoppers see the
new price immediately. The before-snapshot in the audit log captures the
old price for rollback context.

Clicking **Reject** leaves the price unchanged.

## Audit trail

- `before`: variant id, title, product id, product title, old price
- `after`: same fields with the new price
