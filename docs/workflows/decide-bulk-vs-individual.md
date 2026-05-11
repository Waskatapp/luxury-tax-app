---
department: cross-cutting
summary: Decision tree — when to fan out a bulk write tool vs. ask one-by-one
triggers: [all my products, every product, bulk, mass, across the catalog]
priority: 8
---

# Workflow: Decide bulk-vs-individual operation

Tool: `(varies — bulk_update_*, individual update tool, or propose_plan)`

## When this runs

- Merchant's request implies an operation on more than one product / variant / collection
- BEFORE calling any bulk write tool (`bulk_update_titles`, `bulk_update_tags`, `bulk_update_status`, `bulk_update_prices`)
- Whenever you're tempted to call a write tool 10+ times in a row

## Decision tree

1. **Did the merchant name a specific count or scope ("all 70 products", "everything in the Snowboards collection")?**
   → Yes: bulk path. Tool: `bulk_update_*`.
   Pass `productIds` (if you have them) OR `collectionId` (if scope is a collection). Never both.
2. **Is the scope a Shopify collection the merchant mentioned by name?**
   → Yes: bulk path with `collectionId` (after Products dept resolves the name → GID).
3. **Is the count ambiguous but clearly > 3 ("a bunch of", "several", "the slow movers")?**
   → Yes: clarify scope first via `ask_clarifying_question` — but ONLY if the answer changes the bulk vs. individual route. If it's clearly bulk (large number) but the FILTER is unclear, ask the filter, not "bulk or individual".
4. **Is the operation cross-departmental (e.g., archive AND drop price across same set)?**
   → Yes: `propose_plan` with one bulk step per dept; each step still gets its own ApprovalCard at execute time.
5. **Default fallback (count ≤ 3, scope is named individual products):** call individual write tools, one per product. Wrap in `propose_plan` if the merchant explicitly framed it as "first do A, then B".

## Anti-patterns

| Don't | Do instead |
|---|---|
| Loop a single-product write tool 70 times. | Use `bulk_update_*` — partial-failure resilient, one approval card, partitions stale IDs (Re-D). |
| Call `bulk_update_titles` with 1 productId. | Use the individual `update_product_title` for single-item ops. Bulks are for ≥ 2. |
| Pass both `productIds` AND `collectionId` to bulk tools. | XOR — pass exactly one. Zod refinement enforces this; agent should pre-validate. |
| Silently pretend `totalUpdated` is the full count when `missing.length > 0`. | Surface missing IDs explicitly (rule 31). The merchant needs to know what didn't happen. |
| Ask the merchant for product IDs because "the bulk tool needs them". | Resolve via Products dept first (rule 25). Merchants think in names, not GIDs. |

## Examples

- "Add 'waskat' to every product title" → `bulk_update_titles` with `transform: { kind: "append", text: " waskat" }` and `collectionId` if specified, else `productIds` from a fresh `read_products` page.
- "Lower price on the 5 hoodies in the Winter collection" → `bulk_update_prices` (5 IDs ≥ 3 threshold; collection scope helps the resolver).
- "Archive these two — Cat Food and Dog Food" → 2× individual `update_product_status` calls (count = 2 < 3 threshold; named individually).
- "Archive my slow movers" → ambiguous. Ask: "Which products count as slow movers — under N units sold over the last 30 days, or specific ones you'll name?"

## Decision payload (required before next tool call)

Phase Mn Round Mn-2 — after walking this decision tree, emit your decision as a fenced ```json block in your message text IMMEDIATELY before calling the next tool. Required shape:

```json
{
  "workflow": "decide-bulk-vs-individual",
  "approach": "<bulk | individual | ask-merchant | plan>",
  "item_count": <integer — count of items in scope, or 0 if asking>,
  "rationale": "<one short sentence citing the node above that fired>",
  "next_tool": "<bulk_update_titles | bulk_update_tags | bulk_update_status | bulk_update_prices | update_product_title | update_product_status | ... | ask_clarifying_question | propose_plan>"
}
```

If you didn't read this workflow you don't need to emit the payload.
