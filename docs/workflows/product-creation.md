---
department: products
summary: Creating a new product in DRAFT status for the merchant to review
---

# Workflow: Creating a new product (DRAFT)

Tool: `create_product_draft`

## When this runs

The merchant says things like:
- "Create a new product called dog washer"
- "Add a product: hoodie, $40, large size only"
- "Make a draft for our upcoming summer collection"

## Business rules (defaults — edit to match your store)

1. **Always create as DRAFT first**, never as ACTIVE. The merchant
   reviews the draft in Shopify admin (or via this app), tweaks
   anything that's missing, then explicitly publishes via
   `update_product_status`. This is intentional — products that go
   live too fast are a common source of mistakes.
2. **Title is required; everything else is optional.** Vendor,
   product type, and description can be added later.
3. **Default variant gets $0.00 price.** Set the real price via
   `update_product_price` as a separate approval step, after creation.
4. **Don't add multi-variant products in v1.** If the merchant says
   "in three sizes", create the product without variants and tell them
   they'll need to add variants from the Shopify admin (or wait for
   Phase 6 multi-variant tools).
5. **Title length: under 100 characters** ideally. Warn the merchant
   if longer; Shopify allows up to 255.

## Edge cases

- **Duplicate title with an existing product:** not blocked by Shopify,
  but warn the merchant first ("you already have a 'dog washer' — make
  another?").
- **Vendor / product type the merchant types:** preserve their casing
  exactly. Don't title-case "ACME" to "Acme".
- **HTML in the description:** allowed; same rules as
  [product-description.md](product-description.md).

## What approval means

Clicking **Approve** creates the product in Shopify with status
**DRAFT** — invisible to shoppers, visible in Shopify admin.
A default variant is auto-created with $0 price. The tool result
includes the new product's id and the default variant's id, so the
merchant's natural follow-up ("set its price to $20") works without
needing a separate `read_products` call.

Clicking **Reject** does nothing in Shopify.

## Audit trail

- `before`: null (nothing existed)
- `after`: product id, title, handle, status (DRAFT), vendor, product
  type, default variant id and price
