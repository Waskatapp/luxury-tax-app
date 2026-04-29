---
department: products
summary: Rewriting a product's description body (use propose_artifact for canvas)
---

# Workflow: Updating a product's description

Tool: `update_product_description`

## When this runs

The merchant says things like:
- "Rewrite the dog washer description"
- "Make this product copy more luxurious"
- "Punch up the description for X"
- "Update the description to mention free shipping"

## Business rules (defaults — edit to match your brand voice)

1. **Brand voice first.** Match the brand voice stored in
   `StoreMemory(BRAND_VOICE)` once that is wired up in Phase 8. Until
   then, default to: clear, plain-spoken, no exclamation marks, no
   emoji, no all-caps.
2. **HTML, not plain text.** Use `<p>`, `<ul>`/`<li>`, `<strong>`,
   `<em>` only. No inline styles, no `<div>` containers, no `<script>`.
3. **Length: 80–300 words** for typical products. Confirm with the
   merchant before going outside that range.
4. **Don't fabricate features.** Only describe what's grounded in the
   merchant's own words or the existing product copy. If you don't know
   the material / size / origin, ask.
5. **Don't promise things the store can't deliver** — no claims about
   free shipping, returns, warranty, or guarantees unless the merchant
   has explicitly stated those policies in this conversation or in
   StoreMemory.

## Edge cases

- **Wholesale rewrite request without context:** read the existing
  description first via `read_products`, then propose the rewrite.
- **Spelling/style errors in the merchant's prompt text:** preserve
  their text exactly when they paste it; do not "auto-correct" their
  brand voice.
- **Product currently has no description:** treat as a fresh write,
  not a "rewrite". Confirm any factual claims before writing.

## What approval means

Clicking **Approve** replaces the product's `descriptionHtml` field
live — shoppers see the new text immediately on the storefront.

Clicking **Reject** leaves the description unchanged.

## Audit trail

- `before`: product id, title, old descriptionHtml
- `after`: product id, title, new descriptionHtml
