# Workflow file format (Phase Wf Round Wf-B spec)

This file defines the **authoring spec** for everything else in `docs/workflows/`. The CEO loads workflow bodies on demand via the `read_workflow` tool; well-formed workflows make that body short, scannable, and usable as a runbook.

## Frontmatter (required)

Every workflow file starts with a YAML-style frontmatter block:

```
---
name: workflow-name           # optional; defaults to filename without .md
department: products | pricing-promotions | insights | marketing | customers | orders | inventory | cross-cutting
summary: One-line description shown in the workflow index (≤ 140 chars)
triggers: [keyword, multi word phrase, …]   # ≤ 5 entries; whole-word matched, lowercased
priority: 1-10                # default 5; higher wins ties when multiple workflows fire
---
```

- `summary` and `department` are **required**.
- `triggers` is the auto-fire list — Phase Wf-A's matcher tokenizes the merchant's last user message + last assistant message and surfaces the workflow when any trigger hits as a whole word / adjacent token sequence.
- `priority` breaks ties. Default 5. Use 7-8 for high-leverage workflows like decision trees that should win against simpler ones.

## Body sections

### Required for **every** workflow:

```
# Workflow: <Title>            # H1, drives the index summary fallback

Tool: `<primary_tool_name>`    # the main tool this SOP wraps; surfaces in index

## When this runs               # 2-4 bullets — what merchant intent triggers this
## Anti-patterns                # Don't / Do instead table. Sourced from real
                                # failure logs (Wf-C lessons + Ab-A clusters),
                                # not invented.
## Examples                     # 1-3 concrete merchant phrasings + the tool
                                # call shape the agent should produce
```

### Required for **decision-tree** workflows (file prefix `decide-`):

```
## Decision tree                # The branching logic the agent should follow.
                                # Use nested bullets or a table. Each branch
                                # ends with a concrete action ("call X with Y").
```

### Optional sections:

```
## Business rules               # Defaults the merchant has codified
## Edge cases                   # Failure modes + how to handle
## Why                          # Background / motivation
```

## Caps

- 250 lines per workflow body (excluding frontmatter)
- 5 triggers per workflow
- 1 primary tool per workflow (use multiple workflows for multi-tool SOPs)

## Anti-patterns format

The `## Anti-patterns` section uses a 2-column table:

```
| Don't | Do instead |
|---|---|
| Apologize four times when a write fails. | Acknowledge the failure once, then surface the structured error code (rule 32). |
| Pivot to step N+1 when step N blocks. | Pause + offer retry or set aside (rule 33). |
```

Sources for anti-patterns rows (in priority order):
1. Real Wf-C `ConversationFailure` rows the operator has reviewed
2. Real Ab-A abandonment cluster patterns
3. Existing decision-rules.md anti-patterns that apply specifically to this workflow
4. Hand-crafted (last resort)

## Naming conventions

- Filename = workflow name (kebab-case, lowercase, no `.md` in cross-references)
- Decision-tree workflows: `decide-<topic>.md`
- Domain workflows: `<entity>-<action>.md` (e.g., `price-change.md`, `product-creation.md`)
- Avoid generic names like `general.md` or `misc.md` — every workflow should name a specific situation

## Triggers — what makes a good one

- **Specific verbs/nouns the merchant uses**: "discount" / "promo code" / "bulk archive" — yes. "the thing" / "do it" — no.
- **Domain words, not stop words**: avoid "all", "do", "make" alone — they fire on too many turns.
- **Multi-word phrases when the words alone are too generic**: "promo code" beats just "promo" if you only want code-shaped discounts.
- **Whole-word matched**: "price" does NOT fire on "appraised" — that's by design (rule 34 + Wf-A's matcher).

## Lifecycle

- Authored by humans OR auto-proposed by the Skill Creator (Wf-E) and operator-approved
- Files are read once at server start + cached; merchants editing docs see changes after the next deploy
- DB-stored proposed workflows live alongside filesystem ones (Wf-E) — same shape, same loader, same `read_workflow` API
