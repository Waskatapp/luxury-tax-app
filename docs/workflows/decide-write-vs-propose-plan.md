---
department: cross-cutting
summary: Decision tree — single write tool call vs. propose_plan for multi-step requests
triggers: [multi step, several changes, after that, also do, in order]
priority: 7
---

# Workflow: Decide write vs. propose_plan

Tool: `propose_plan` (or any single write)

## When this runs

- Merchant's request involves more than one write
- Or the request crosses departments (e.g., update product description AND change price)
- BEFORE calling either a single write or `propose_plan`

## Decision tree

1. **Is the request a SINGLE atomic write?**
   ("lower Cat Food to $19.99", "archive the orange snowboard", "add a tag to one product")
   → Yes: call the write tool directly. The existing ApprovalCard is enough — don't wrap a single op in a plan.
2. **Is the request 2-3 writes BUT all the same shape (same dept, same operation kind)?**
   ("archive these 5", "drop price on these 3 by 10%")
   → Yes: route via `decide-bulk-vs-individual.md`. Bulk tools (≥ 3) or individual writes (≤ 2). NOT a plan.
3. **Does the request have 2+ steps that cross departments OR have ordering ("first … then …")?**
   ("rewrite the description, then drop the price", "audit catalog and lower any overpriced items")
   → Yes: `propose_plan`. The merchant approves the plan as a unit; each WRITE step still gets its own approval card during execute.
4. **Is the request EXPLORATORY ("audit my catalog", "find me opportunities")?**
   → Yes: don't propose_plan yet. First read (use `delegate_parallel` or `delegate_to_department(insights)` to gather data), THEN propose_plan if action is justified.

## Anti-patterns

| Don't | Do instead |
|---|---|
| Wrap a single write in `propose_plan`. | Call the write tool directly. The ApprovalCard already shows before/after. |
| Use `propose_plan` to enumerate 28 line items ("step 1: lower X to $5, step 2: lower Y to $5, …"). | Use ONE strategic step ("Apply $5 floor to the 28 items above $5") + a bulk write at execute time. (Rule 9 — plans are STRATEGIC, ≤ 8 steps.) |
| Skip `propose_plan` for a multi-step request because "the merchant just wants it done". | The plan card surfaces the strategy before execute. It also enables Re-C2 resume + step-state tracking — a bare write loop has none of that. |
| Propose a plan that violates strategic guardrails without surfacing the conflict. | Check active goals (`goal:active:*`) BEFORE the plan card; surface the conflict in plain text first (rule 8). |
| Use `propose_plan` to ASK questions. | Use `ask_clarifying_question` for questions; reserve plans for proposed action sequences. |

## Examples

- "Lower Cat Food to $19.99" → single write (`update_product_price` after Products dept resolves variant ID).
- "Archive these 5 products: A, B, C, D, E" → `bulk_update_status` (count ≥ 3; same op kind).
- "Rewrite the description, then archive the old SKU, then create a draft for the new model" → `propose_plan` with 3 steps (3 different ops, ordered).
- "Audit my catalog and lower anything overpriced" → first `delegate_parallel` (Insights + Products) to find candidates; then `propose_plan` if action is warranted.
- "Set up a Black Friday sale" → `propose_plan` (cross-dept: Pricing creates the discount, Marketing announces, Products may flag stock).
