# Sub-Agent Architecture

> Status: shipped 2026-05-02. Sub-1 → Sub-5 phases complete.
> Plan that drove this: see project memory `project_phase_3_plus_roadmap.md` and the migration plan that lived at `~/.claude/plans/this-my-shopify-embedded-lucky-koala.md`.

## What this is

A CEO agent that orchestrates **department sub-agents** instead of holding every tool itself. Each department is a focused module that loads only its own tools when invoked. The CEO sees a single meta-tool (`delegate_to_department`) plus a few orchestration primitives (`propose_plan`, `propose_artifact`, `propose_followup`, `update_store_memory`, `ask_clarifying_question`, `read_workflow`).

## Why we built it

The CEO's prompt was loading all ~13 tool declarations every turn (~3K tokens) regardless of what the merchant asked for. Adding the planned next departments (Marketing, Customer Service, etc.) would have pushed it to 50+ tools = ~12K tokens of definitions per turn, eating into Gemini's 32K cache window and diluting the model's attention.

The fix: each department lives as a self-contained module behind a sub-agent dispatcher. The CEO's prompt stays small forever; new tools land in their department without touching central files.

The architecture **mirrors literal MCP** (Model Context Protocol — Anthropic's standard for tool servers) but runs in-process. We chose in-process because:
- React Router 7 + Railway doesn't fit MCP's separate-process server model cleanly
- Gemini doesn't speak MCP natively (Claude does); a translation bridge would have been added engineering for no immediate gain
- The approval flow is tightly coupled to our app — splitting tools into separate processes would have meant re-implementing the safety primitive across boundaries

If Phase IT-full ever lands the Anthropic Claude code-writing arm, lifting in-process modules into separate MCP servers is a mechanical refactor. The shape is right.

## File layout

```
app/lib/agent/
├── sub-agent.server.ts                  # Dispatcher (runSubAgent)
├── tools.ts                             # CEO meta-tools (~7 declarations)
├── tool-classifier.ts                   # Read/write classification (UI-side flat list)
├── executor.server.ts                   # CEO meta-tool dispatch + registry-driven write dispatch
└── departments/
    ├── department-spec.ts               # Shared types (DepartmentSpec, ToolHandler, SubAgentResult, ProposedWrite, SubAgentReadCall)
    ├── registry.server.ts               # In-process registry (Map<DepartmentId, DepartmentSpec>)
    ├── registry-entrypoint.server.ts    # Imports each department for side-effect registration
    ├── insights/
    │   ├── index.ts                     # DepartmentSpec — registers itself on import
    │   ├── handlers.ts                  # ToolHandlers wrapping shopify modules
    │   └── prompt.md                    # Focused manager prompt (Vite ?raw)
    ├── products/
    │   ├── index.ts
    │   ├── handlers.ts
    │   └── prompt.md
    └── pricing-promotions/
        ├── index.ts
        ├── handlers.ts
        └── prompt.md
```

## How a delegated turn flows

```
Merchant → "Lower Cat Food to $19.99"
    ↓
CEO turn (Gemini 2.5 Flash, full prompt with departments section)
    ↓
CEO emits tool_use(delegate_to_department, { department: "products",
                  task: "Find Cat Food and return variant ID + current price" })
    ↓
api.chat.tsx → executeTool → executor's delegate_to_department case
    ↓
runSubAgent({ departmentId: "products", task, context })
    ↓
Loads PRODUCTS_SPEC from registry
Builds focused prompt (products/prompt.md)
Calls Gemini with ONLY Products' tool list (read_products, read_collections, ...)
    ↓
Sub-agent emits tool_use(read_products, { query: "cat food" })
Dispatcher recognizes READ → calls handlers.get("read_products")(input, ctx)
Handler wraps the existing Shopify readProducts() function
    ↓
Sub-agent emits final text: "Cat Food variant gid://...XYZ, current price $24.99"
Dispatcher returns SubAgentResult.completed { summary, readsExecuted: [{...read_products call data...}] }
    ↓
api.chat.tsx detects "completed" with reads → synthesizes:
  - tool_use(read_products, ...) appended to assistant message
  - tool_result for that synthetic id appended to user message
Updates persisted message + replaces last contents entry for Gemini history coherence
    ↓
CEO turn 2 sees the read_products result in context
    ↓
CEO emits tool_use(delegate_to_department, { department: "pricing-promotions",
                  task: "Update variant gid://...XYZ from $24.99 to $19.99" })
    ↓
runSubAgent({ departmentId: "pricing-promotions", ... })
Sub-agent emits tool_use(update_product_price, { productId, variantId, newPrice })
Dispatcher recognizes WRITE → adds to ProposedWrite[], halts
Returns SubAgentResult.proposed_writes { writes: [...], rationale }
    ↓
api.chat.tsx detects "proposed_writes" → synthesizes:
  - tool_use(update_product_price, ...) appended to assistant message
  - Adds to pendingWrites; flags hadWriteTool=true; pushes id to writeToolCallIds
    ↓
Pass 2 (existing pendingWrites flow): upsert PendingAction, emit tool_use_start SSE
ApprovalCard renders for the merchant
    ↓
Merchant approves → POST /api/tool-approve
processApproveBatch → snapshot + execute callbacks
executeApprovedWrite("update_product_price", input, ctx)
    ↓
departmentForTool("update_product_price") → "pricing-promotions"
spec.handlers.get("update_product_price") → updateProductPriceHandler
Handler wraps the existing Shopify updateProductPrice() function
    ↓
Mutation runs, AuditLog written, read cache invalidated
Tool result flows back to CEO as next-turn input
```

The merchant sees: "I'll lower Cat Food to $19.99" → ApprovalCard → Approve → "Done, $24.99 → $19.99". Identical UX to pre-migration.

## Key contracts

### `DepartmentSpec`

The unit of registration. Every department exports one and registers it on module load.

```ts
type DepartmentSpec = {
  id: DepartmentId;             // "products" | "pricing-promotions" | "insights"
  label: string;                // Display name
  managerTitle: string;         // For routing pill
  description: string;          // 1-line for CEO routing
  systemPrompt: string;         // From prompt.md via Vite ?raw
  toolDeclarations: FunctionDeclaration[];  // Gemini-shaped, dept's tools only
  handlers: Map<string, ToolHandler>;       // tool name → async handler
  classification: { read: Set, write: Set, inlineWrite: Set };
};
```

### `ToolHandler`

Same signature as the legacy executor's switch arms. Easy to lift functions in.

```ts
type ToolHandler = (input: unknown, ctx: HandlerContext) => Promise<ToolResult>;
type HandlerContext = { storeId; admin; conversationId?; toolCallId? };
type ToolResult = { ok: true; data } | { ok: false; error };
```

### `SubAgentResult`

Discriminated union. Each kind triggers different orchestration in `api.chat.tsx`.

```ts
type SubAgentResult =
  | { kind: "completed";          summary: string;   readsExecuted: SubAgentReadCall[] }
  | { kind: "proposed_writes";    writes: ProposedWrite[]; rationale: string }
  | { kind: "needs_clarification"; question: string }
  | { kind: "error";              reason: string };
```

`completed` and `proposed_writes` both lift their internal tool calls to synthetic blocks at the CEO level so the UI renders cards (AnalyticsCard, ApprovalCard) exactly as before migration.

## Approval flow (preserved end-to-end)

The approval primitive is **unchanged at the merchant boundary**. Sub-agents PROPOSE writes; they don't execute them. Each `ProposedWrite` becomes a synthetic `tool_use` block on the CEO's assistant message, which:

1. Creates a `PendingAction` row (idempotent on `toolCallId`)
2. Emits `tool_use_start` SSE event
3. Halts the agent loop until merchant clicks Approve

On approval, `executeApprovedWrite` looks up the owning department via `departmentForTool(name)` and calls `spec.handlers.get(name)`. The Shopify mutation runs, AuditLog row is written, cache is invalidated.

The merchant doesn't know or care that a sub-agent ran in between.

## Adding things

### A new tool to an existing department

1. Add the handler function to `departments/<dept>/handlers.ts`
2. Add the `FunctionDeclaration` to `departments/<dept>/index.ts`
3. Register it in the spec's `handlers` Map
4. Add the tool name to the appropriate `classification` set (`read` / `write` / `inlineWrite`)
5. If WRITE: also add the name to `tool-classifier.ts`'s `APPROVAL_REQUIRED_WRITE_TOOLS` (UI rendering needs it on the client side)
6. Update `app/lib/agent/departments.ts` `DEPARTMENTS[].toolNames` so the routing pill knows the owner

### A new department

1. Create `app/lib/agent/departments/<id>/` with `index.ts`, `handlers.ts`, `prompt.md`
2. Add to `registry-entrypoint.server.ts`
3. Add a new entry to `app/lib/agent/departments.ts` `DEPARTMENTS` array (client-safe routing pill catalog)
4. Update `DepartmentId` union in `departments.ts` to include the new id

That's it. CEO awareness is automatic via `buildDepartmentsSection` which iterates the registry.

## Things that intentionally didn't change

- **`app/lib/shopify/*` modules** — products, pricing, discounts, analytics, collections. Department handlers wrap them; the underlying Shopify calls are identical to pre-migration.
- **`app/lib/memory/*` modules** — store memory remains a CEO-level primitive (`update_store_memory` is a meta-tool, not a department tool).
- **Prisma schema** — no schema changes. PendingAction, AuditLog, Message, etc. all unchanged.
- **`app/routes/api.tool-approve.tsx`** — receives toolCallId, fetches PendingAction, calls processApproveBatch with executeApprovedWrite. The dispatch INSIDE executeApprovedWrite changed (registry-driven), but the route's contract didn't.
- **`app/components/chat/*`** — ApprovalCard, AnalyticsCard, MessageBubble all unchanged. Their rendering keys off persisted `tool_use` and `tool_result` blocks; the synthetic-blocks lift in `api.chat.tsx` ensures those blocks land on every message exactly like pre-migration.

## Constraints (the constitution for this layer)

1. **Sub-agent is single-shot per delegation.** Up to 4 internal rounds, then either `completed` (with reads) or `proposed_writes` (with writes). Multi-turn back-and-forth with the merchant is the CEO's job — re-delegate on the next merchant turn.
2. **Sub-agents cannot delegate.** Only the CEO calls `delegate_to_department`. Avoids loops and approval-flow chaos.
3. **CEO meta-tools never move.** `propose_plan`, `propose_artifact`, `propose_followup`, `update_store_memory`, `ask_clarifying_question`, `read_workflow`, `delegate_to_department` are orchestration primitives, not domain tools.
4. **The merchant never types Shopify GIDs.** If a department needs a `productId` or `variantId`, the CEO chains a Products delegation FIRST to fetch it (rule 26 in `decision-rules.md`).
5. **Approval flow is sacred.** Sub-agent writes become PendingActions; nothing bypasses ApprovalCard.

## Migration commits (for archaeology)

- `e7262f4` — Sub-1: dispatcher infrastructure + delegate_to_department + pilot smoke fixture
- `bddff19` — Sub-2: Insights department migrated
- `a0df332` — Sub-2 hotfix: synthetic tool_use+tool_result blocks for sub-agent reads (UI cards render)
- `056992a` — Sub-3: Products department migrated + proposed-writes integration
- `9ae9a00` / `654fdec` — Sub-4: Pricing & Promotions migrated; legacy switch retired
- `f2bead8` — Sub-4 hotfix: chain-delegation rule (rule 26) — CEO never asks merchant for GIDs
- `[this commit]` — Sub-5: pilot removed, isDepartmentMigrated fork dropped, this doc
