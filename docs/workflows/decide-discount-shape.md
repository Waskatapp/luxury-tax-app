---
department: pricing-promotions
summary: Decision tree — which discount shape (automatic / code / bundle / per-product) fits the merchant's request
triggers: [bundle discount, promo code, code based discount, storefront discount, automatic discount]
priority: 8
---

# Workflow: Decide the discount shape

Tool: `create_discount`

## When this runs

- Merchant asks for any kind of sale, promo, deal, or coupon
- The phrasing leaves the discount SHAPE ambiguous (storefront-wide vs. code-based vs. bundle)
- BEFORE calling `create_discount` / `create_discount_code` / `create_bundle_discount`

## Decision tree

Walk the questions in order. The first **yes** wins; stop and route.

1. **Did the merchant say "code", "coupon", or "promo code"?**
   → Yes: code-based discount. Tool: `create_discount_code`.
   The merchant gives a code (e.g., `WELCOME10`); customers type it at checkout.
2. **Did the merchant name 2+ specific products to bundle?**
   → Yes: bundle discount. Tool: `create_bundle_discount`.
   Example: "20% off when buying snowboard + boots together".
   IDs MUST be fetched via Products first — never ask the merchant for GIDs (rule 25).
3. **Did the merchant say "automatic", "storefront-wide", "site-wide", or describe a sale visible to everyone?**
   → Yes: automatic storefront discount. Tool: `create_discount`.
   No code; visible to all customers; targets a collection or product list.
4. **Default fallback (when all above are no):** automatic storefront discount.
   In that case, ask ONCE if the merchant wants it code-based instead — but ONLY if the discount targets a small audience (loyalty, recovery, retention). Catalog-wide sales default to automatic.

## Anti-patterns

| Don't | Do instead |
|---|---|
| Default to `create_discount_code` because "every sale needs a code". | Read the merchant's words. Catalog-wide sales are automatic by default. |
| Ask the merchant "which products?" for a 100%-of-catalog discount. | Infer from their wording (e.g., "20% off everything" → all products). |
| Create a bundle discount with one product. | Bundles need ≥ 2 distinct products. If only one product is named, route to per-product or storefront. |
| Fabricate a code (e.g., `SUMMER25`) when the merchant didn't specify one. | If routing to code-based, ASK once: "What code should customers type at checkout?" |
| Skip the date check. | If the merchant said "this weekend" / "for July", set startsAt + endsAt. |

## Examples

- "Set up a 20% promo code for the weekend" → `create_discount_code` (code-based; `code` field needed; ask if not specified)
- "20% off snowboards + boots when bought together" → `create_bundle_discount` (find both via Products first)
- "Site-wide 15% sale for Black Friday" → `create_discount` (automatic storefront; targets all collections)
- "Create a discount" (no qualifier) → ask one clarifying question: "Storefront sale, or a code customers enter?"
