// V-Sub-4 — all write executors migrated to department modules
// (Products, Pricing & Promotions). We still import the snapshot
// helpers (fetchProductDescription, fetchProductStatus, fetchVariantPrice)
// because snapshotBefore() builds AuditLog pre-state by tool name
// regardless of which department owns the executor — keeping the
// snapshot logic centralized avoids duplicating it across departments.
import {
  fetchProductDescription,
  fetchProductForDuplicate,
  fetchProductMedia,
  fetchProductStatus,
  fetchProductTags,
  fetchProductTitle,
  fetchProductType,
  fetchProductVendor,
  fetchVariantDetails,
} from "../shopify/products.server";
import { fetchCollectionDetails } from "../shopify/collections.server";
import { fetchVariantPrice } from "../shopify/pricing.server";
import { fetchDiscount } from "../shopify/discounts.server";
import {
  fetchCollectionSeo,
  fetchProductSeo,
} from "../shopify/seo.server";
import { fetchArticle } from "../shopify/articles.server";
import { fetchPage } from "../shopify/pages.server";
import { fetchCustomerDetail } from "../shopify/customers.server";
import { fetchOrderDetail } from "../shopify/orders.server";
import { fetchInventoryLevels } from "../shopify/inventory.server";
// V-Sub-2 — getAnalytics import removed: get_analytics migrated to the
// Insights department (app/lib/agent/departments/insights/). The
// underlying app/lib/shopify/analytics.server.ts module is unchanged;
// only the central executor no longer routes to it directly.
import type { ShopifyAdmin } from "../shopify/graphql-client.server";
import { upsertMemory } from "../memory/store-memory.server";
import {
  pruneOldObservations,
  recordObservation,
} from "./conversation-observations.server";
import {
  ProposePlanInputSchema,
  findActivePlan,
  findPlanById,
  markStepCompleted,
  markStepFailed,
  safeCreatePlan,
} from "./plans.server";
import {
  ProposeArtifactInputSchema,
  safeCreateArtifact,
  artifactSummary,
} from "./artifacts.server";
import {
  ProposeFollowupInputSchema,
  safeCreateFollowup,
  followupSummary,
} from "./followups.server";
import { loadWorkflowBodyByName } from "./workflow-loader.server";
import { runSubAgent } from "./sub-agent.server";
// V-Sub-3 — registry-driven dispatch for executeApprovedWrite. Migrated
// tools route through their department's handler instead of the central
// switch. Side-effect import of the entrypoint populates the registry
// at module load time.
import "./departments/registry-entrypoint.server";
import {
  departmentForTool,
  getDepartmentSpec,
} from "./departments/registry.server";
import {
  CACHEABLE_READ_TOOLS,
  readCacheGet,
  readCacheInvalidate,
  readCacheSet,
} from "./read-cache.server";
import type { MemoryCategory } from "@prisma/client";
import { z } from "zod";
import {
  classifyError,
  errorMessage,
  type ErrorCode,
} from "./error-codes";
import { isIdempotent } from "./tool-classifier";

// Phase Mn Round Mn-3 — note_observation meta-tool input. Mirrors
// MAX_OBSERVATION_KIND_LEN + MAX_OBSERVATION_SUMMARY_LEN bounds from
// conversation-observations.server.ts so Zod rejects oversize inputs
// before they reach the DB writer.
const NoteObservationInput = z.object({
  kind: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "kind must be kebab-case (a-z, 0-9, hyphen)"),
  summary: z.string().min(1).max(500),
  sourceToolName: z.string().min(1).max(80).optional(),
});

const UpdateStoreMemoryInput = z.object({
  category: z.enum([
    "BRAND_VOICE",
    "PRICING_RULES",
    "PRODUCT_RULES",
    "CUSTOMER_RULES",
    "STORE_CONTEXT",
    "OPERATOR_PREFS",
    "STRATEGIC_GUARDRAILS",
  ]),
  key: z
    .string()
    .min(1)
    .max(80)
    // V5.1 — accept `:` as a key separator so the CEO can use the
    // `goal:active:revenue_q2_2026` convention for strategic objectives
    // stored under STRATEGIC_GUARDRAILS. Backwards-compatible: every
    // existing snake_case key still validates.
    .regex(/^[a-z0-9_:]+$/, "key must be snake_case (a-z, 0-9, underscore, colon for goal: prefix)"),
  value: z.string().min(1).max(500),
});

// V2.2 — ask_clarifying_question. Up to 4 short option strings. We cap
// at 4 to keep the rendered prompt readable; Gemini will sometimes try
// to send 6+ which we truncate rather than reject.
const AskClarifyingQuestionInput = z.object({
  question: z.string().min(1).max(400),
  options: z
    .array(z.string().min(1).max(80))
    .max(8)
    .optional()
    .transform((arr) => (arr ? arr.slice(0, 4) : [])),
});

// V-Sub-1 — delegate_to_department. The CEO names a department + task.
// The dispatcher (sub-agent.server.ts) validates the department id
// against the registry — no need to enum it here, and listing valid ids
// would create a maintenance hotspot every time a new department lands.
// Task length capped to keep the sub-agent's user message focused; the
// CEO should be summarizing intent, not forwarding the merchant's full
// message.
const DelegateToDepartmentInput = z.object({
  department: z.string().min(1).max(80),
  task: z.string().min(1).max(2000),
  conversationContext: z.string().max(2000).optional(),
});

// Phase Wf Round Wf-D — delegate_parallel input. 2-5 read-only
// delegations executed concurrently via Promise.all. Each delegation
// reuses the DelegateToDepartmentInput shape.
const DelegateParallelInput = z.object({
  delegations: z
    .array(DelegateToDepartmentInput)
    .min(2)
    .max(5),
});

// Phase Re Round Re-A — failure case carries a typed { code, retryable }
// pair so the agent + downstream retry harness know how to react. See
// app/lib/agent/error-codes.ts for the enum + classifier.
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code: ErrorCode; retryable: boolean };

// Helper: build a typed failure ToolResult. Auto-classifies the error
// string via classifyError unless the caller passes an explicit override.
// Use this everywhere we previously returned `{ ok: false, error: "..." }`
// — keeps the typed contract consistent without re-typing the same
// boilerplate at every callsite.
export function fail(
  error: string | unknown,
  override?: Partial<{ code: ErrorCode; retryable: boolean }>,
): { ok: false; error: string; code: ErrorCode; retryable: boolean } {
  const message = typeof error === "string" ? error : errorMessage(error);
  const classified = classifyError(message);
  return {
    ok: false,
    error: message,
    code: override?.code ?? classified.code,
    retryable: override?.retryable ?? classified.retryable,
  };
}

// Coerce a department handler's loose return shape into the strict
// ToolResult. Success cases pass through; failure cases get classified.
// This is the boundary where we decide "is this retryable?" for the
// downstream Re-B retry harness.
export function coerceHandlerResult(
  result: { ok: true; data: unknown } | { ok: false; error: string },
): ToolResult {
  if (result.ok) return result;
  return fail(result.error);
}

// Phase Re Round Re-C1 — try to advance the active plan's step
// pointer based on a tool-dispatch result. No-op when:
//   - no conversationId in scope (cron/eval-harness paths)
//   - no APPROVED plan exists for the conversation
//   - the tool's department doesn't match the current step's department
//   - currentStepIndex is past the last step (defensive)
//
// On match, transitions pending → completed (success) or pending →
// failed (failure). markStepCompleted bumps currentStepIndex; markStepFailed
// pins lastStepFailureCode for Re-C2's resume detection. Both helpers
// are atomic (guarded updateMany) so concurrent dispatches don't
// double-advance.
//
// Best-effort: any error here (DB blip, race, etc.) is logged + swallowed
// so a bug in step tracking can never break the underlying tool result.
async function tryAdvancePlanStep(opts: {
  storeId: string;
  conversationId: string | undefined;
  toolDepartmentId: string | null;
  result: ToolResult;
}): Promise<void> {
  if (!opts.conversationId) return;
  if (!opts.toolDepartmentId) return;
  try {
    const plan = await findActivePlan(opts.storeId, opts.conversationId);
    if (!plan) return;
    const idx = plan.currentStepIndex;
    if (idx >= plan.steps.length) return;
    const step = plan.steps[idx];
    if (step.departmentId !== opts.toolDepartmentId) return;
    if (opts.result.ok) {
      await markStepCompleted({
        planId: plan.id,
        storeId: opts.storeId,
        expectedIndex: idx,
      });
    } else {
      await markStepFailed({
        planId: plan.id,
        storeId: opts.storeId,
        expectedIndex: idx,
        failureCode: opts.result.code,
      });
    }
  } catch {
    // Step tracking is observational; never break the underlying tool.
  }
}

// Phase Re Round Re-B — auto-retry harness. Wraps a tool-execution thunk
// with a single retry on transient errors when the tool is idempotent.
// Cap on total wallclock is 90s by default. The caller passes a
// notifier callback that can emit an SSE `tool_retry_pending` event so
// the client can show a "retrying in Ns…" banner instead of silence.
//
// Decision logic:
//   1. Run attempt 1. If OK, return.
//   2. If !retryable OR !idempotent OR remaining-wallclock < delayMs,
//      return the attempt-1 failure unchanged.
//   3. Sleep with backoff (RATE_LIMITED_BURST: 30s, NETWORK: 5s) ±20%
//      jitter, then run attempt 2. Return attempt-2 result.
//
// Constitutional guarantees:
//   - Fail-soft: any thrown exception inside the retry harness is wrapped
//     via fail(). Bugs in the harness never block the underlying tool.
//   - Approval flow untouched: this only retries the EXECUTION, never the
//     approval. Caller passes the same args both attempts.
//   - Idempotency-gated: only tools in IDEMPOTENT_TOOLS get attempt 2.
type RetryNotifier = (info: {
  toolName: string;
  delaySeconds: number;
  reasonCode: ErrorCode;
  attemptNumber: number;
}) => void;

const RETRY_BACKOFF_MS: Record<string, number> = {
  RATE_LIMITED_BURST: 30_000,
  NETWORK: 5_000,
};
const DEFAULT_RETRY_BACKOFF_MS = 5_000;
const RETRY_WALLCLOCK_BUDGET_MS = 90_000;
const JITTER_FRACTION = 0.2;

export async function withRetry(
  toolName: string,
  attempt: () => Promise<ToolResult>,
  options?: {
    notify?: RetryNotifier;
    maxWallclockMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<ToolResult> {
  const maxMs = options?.maxWallclockMs ?? RETRY_WALLCLOCK_BUDGET_MS;
  const sleepFn =
    options?.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = Date.now();

  let first: ToolResult;
  try {
    first = await attempt();
  } catch (err) {
    return fail(err);
  }

  if (first.ok) return first;
  if (!first.retryable) return first;

  // Idempotency check uses the lazy import below to avoid a cycle: the
  // tool-classifier has its own zero-deps module, but tests import
  // executor.server.ts which imports it transitively. Cleanest path is
  // the static import at the top of this file.
  if (!isIdempotent(toolName)) return first;

  const baseDelay =
    RETRY_BACKOFF_MS[first.code] ?? DEFAULT_RETRY_BACKOFF_MS;
  const jitter = (Math.random() * 2 - 1) * JITTER_FRACTION * baseDelay;
  const delayMs = Math.max(1_000, Math.floor(baseDelay + jitter));

  if (Date.now() - start + delayMs > maxMs) {
    // Not enough wallclock budget left to retry; surface attempt-1 failure
    // as `errored_unrecovered` to the caller.
    return first;
  }

  if (options?.notify) {
    try {
      options.notify({
        toolName,
        delaySeconds: Math.ceil(delayMs / 1000),
        reasonCode: first.code,
        attemptNumber: 2,
      });
    } catch {
      // Notifier is best-effort; never let it bubble.
    }
  }

  await sleepFn(delayMs);

  try {
    return await attempt();
  } catch (err) {
    return fail(err);
  }
}

export type ToolContext = {
  admin: ShopifyAdmin;
  storeId: string;
  // V2.3 — set by api.chat.tsx when calling executeTool. Orchestration
  // tools (propose_plan) need these to persist their state. Optional so
  // the same ToolContext shape works for snapshotBefore / executeApprovedWrite
  // callers that don't have a conversationId/toolCallId in scope.
  // Orchestration handlers must guard with a null check.
  conversationId?: string;
  toolCallId?: string;
};

// READ tools — called inline by the agent loop in api.chat.tsx.
// WRITE tools intentionally return an error here; they go through the approval
// flow via executeApprovedWrite below (CLAUDE.md rule #1).
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    // V2.4 — read-tool cache. 5-min TTL per conversation. Saves Shopify
    // calls AND keeps Gemini history slimmer. Invalidated on writes
    // (see executeApprovedWrite below). Only wired when conversationId
    // is in scope; the snapshot path doesn't pass one and shouldn't
    // hit the cache anyway.
    if (ctx.conversationId && CACHEABLE_READ_TOOLS.has(name)) {
      const cached = readCacheGet(ctx.conversationId, name, input);
      if (cached !== undefined) {
        return { ok: true, data: cached };
      }
    }

    switch (name) {
      // V-Sub-3 — read_products, read_collections MIGRATED to the
      // Products department (handlers wrap the same Shopify functions).
      // V-Sub-2 — get_analytics MIGRATED to the Insights department.
      // The CEO no longer invokes any of these directly; it calls
      // delegate_to_department which dispatches into the owning module.

      case "read_workflow": {
        // V2.5a — fetch one workflow's body on demand. The CEO sees only
        // a workflow index in its system prompt; this tool exposes the
        // full SOP. Pure file-system read (no Shopify, no DB), so we
        // skip the admin/storeId path entirely.
        const parsed = z
          .object({
            name: z
              .string()
              .min(1)
              .max(80)
              .regex(/^[A-Za-z0-9_-]+$/)
              .transform((s) => s.toLowerCase()),
          })
          .safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, {
            code: "INVALID_INPUT",
            retryable: false,
          });
        }
        const body = loadWorkflowBodyByName(parsed.data.name);
        if (body === null) {
          return fail(
            `unknown workflow: '${parsed.data.name}'. Check the workflow index in your system prompt for valid names.`,
            { code: "ID_NOT_FOUND", retryable: false },
          );
        }
        const result = {
          ok: true as const,
          data: { name: parsed.data.name, body },
        };
        if (ctx.conversationId) {
          readCacheSet(ctx.conversationId, name, input, result.data);
        }
        return result;
      }

      case "propose_plan": {
        if (!ctx.conversationId || !ctx.toolCallId) {
          return fail(
            "propose_plan requires conversationId + toolCallId in context — this is an internal wiring bug, not a tool input issue",
            { code: "UNKNOWN", retryable: false },
          );
        }
        const parsed = ProposePlanInputSchema.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        // V5.3 — when parentPlanId is set, this is a replan. Verify the
        // claimed parent exists in THIS store BEFORE persisting; otherwise
        // a malformed id from a confused CEO turn would either FK-error at
        // insert time (ugly) or silently link to a different tenant's plan
        // (not possible due to the FK + storeId scope, but defensive). On
        // a bad parent id we return a clear tool-result error so the CEO
        // can correct on the next turn — likely it just hallucinated the id.
        let parentPlanId: string | null = null;
        if (parsed.data.parentPlanId) {
          const parent = await findPlanById(
            ctx.storeId,
            parsed.data.parentPlanId,
          );
          if (!parent) {
            return fail(
              `parentPlanId '${parsed.data.parentPlanId}' not found in this store. If you're replanning, double-check the original plan's id from the prior tool_result. Otherwise, omit parentPlanId for a fresh plan.`,
              { code: "ID_NOT_FOUND", retryable: false },
            );
          }
          parentPlanId = parent.id;
        }
        const plan = await safeCreatePlan({
          storeId: ctx.storeId,
          conversationId: ctx.conversationId,
          toolCallId: ctx.toolCallId,
          summary: parsed.data.summary,
          steps: parsed.data.steps,
          parentPlanId,
        });
        if (!plan) {
          return fail(
            "could not persist the plan; if this happens again, ask the merchant to retry the request",
            { code: "UPSTREAM_ERROR", retryable: true },
          );
        }
        // Tool result echoes the plan + initial PENDING status. Gemini
        // sees this on continuation and knows to wait for the merchant's
        // approval before executing the steps. The chat route also breaks
        // the agent loop after a propose_plan call — same pattern as
        // ask_clarifying_question.
        return {
          ok: true,
          data: {
            planId: plan.id,
            parentPlanId: plan.parentPlanId,
            summary: plan.summary,
            steps: plan.steps,
            status: plan.status,
            note: plan.parentPlanId
              ? "Replan persisted with link to the original plan. Wait for the merchant's approval before executing any of these new steps."
              : "Plan persisted. Wait for the merchant's approval before executing any of these steps. Each WRITE step will still get its own approval card when you call its tool.",
          },
        };
      }

      case "propose_artifact": {
        if (!ctx.conversationId || !ctx.toolCallId) {
          return fail(
            "propose_artifact requires conversationId + toolCallId in context — this is an internal wiring bug, not a tool input issue",
            { code: "UNKNOWN", retryable: false },
          );
        }
        const parsed = ProposeArtifactInputSchema.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        const artifact = await safeCreateArtifact({
          storeId: ctx.storeId,
          conversationId: ctx.conversationId,
          toolCallId: ctx.toolCallId,
          kind: parsed.data.kind,
          content: {
            productId: parsed.data.productId,
            productTitle: parsed.data.productTitle,
            html: parsed.data.content,
          },
        });
        if (!artifact) {
          return fail(
            "could not persist the artifact; if this happens again, ask the merchant to retry the request",
            { code: "UPSTREAM_ERROR", retryable: true },
          );
        }
        // The chat route emits an `artifact_open` SSE event from this
        // result and breaks the agent loop so the merchant can edit and
        // approve in the panel. Note: the result intentionally does NOT
        // include the full HTML body — only a preview/summary — so
        // Gemini's history doesn't bloat with redundant prose. The
        // canonical content lives in the Artifact row + the open panel.
        return {
          ok: true,
          data: {
            ...artifactSummary(artifact),
            note: "Artifact draft saved. The merchant is editing it in the side panel — wait for their decision before proceeding. On approval, the edited content will be applied via update_product_description (its regular approval audit still fires).",
          },
        };
      }

      case "propose_followup": {
        // V3.1 — Phase 3 Autonomous Reasoning Loop. Persist an
        // ActionFollowup row so the offline evaluator can pick it up
        // when the criteria are met. No approval card, no Shopify
        // mutation. Unlike propose_plan / propose_artifact, this does
        // NOT pause the agent loop — the CEO queues the followup and
        // continues the turn (often with a confirmation message).
        const parsed = ProposeFollowupInputSchema.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        const followup = await safeCreateFollowup({
          storeId: ctx.storeId,
          conversationId: ctx.conversationId ?? null,
          input: {
            ...parsed.data,
            // Forward the toolCallId from context if the CEO didn't
            // pass it explicitly — useful for tying the followup back
            // to the assistant message that spawned it.
            toolCallId: parsed.data.toolCallId ?? ctx.toolCallId,
          },
        });
        if (!followup) {
          return fail(
            "could not persist the followup; if this happens again, ask the merchant to retry the request",
            { code: "UPSTREAM_ERROR", retryable: true },
          );
        }
        return {
          ok: true,
          data: {
            ...followupSummary(followup),
            note: "Followup queued. The offline evaluator runs daily — when your criteria are met, it'll write an Insight the merchant sees in the next conversation. Continue the turn; no need to wait.",
          },
        };
      }

      case "ask_clarifying_question": {
        const parsed = AskClarifyingQuestionInput.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        // No store mutation — just echoes the question/options back. The
        // chat route emits a `clarification_asked` SSE event from this
        // result and breaks the agent loop so the merchant can answer.
        return {
          ok: true,
          data: {
            question: parsed.data.question,
            options: parsed.data.options,
          },
        };
      }

      case "update_store_memory": {
        const parsed = UpdateStoreMemoryInput.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        const saved = await upsertMemory(
          ctx.storeId,
          {
            category: parsed.data.category as MemoryCategory,
            key: parsed.data.key,
            value: parsed.data.value,
          },
          "tool",
        );
        return {
          ok: true,
          data: {
            category: saved.category,
            key: saved.key,
            value: saved.value,
            updatedAt: saved.updatedAt.toISOString(),
          },
        };
      }

      case "note_observation": {
        // Phase Mn Round Mn-3 — save an in-conversation observation. No
        // approval, memory-only. Best-effort: recordObservation swallows
        // its own errors so a transient DB hiccup never blocks the loop.
        const parsed = NoteObservationInput.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        if (!ctx.conversationId) {
          return fail("note_observation requires conversationId", { code: "INVALID_INPUT", retryable: false });
        }
        await recordObservation({
          storeId: ctx.storeId,
          conversationId: ctx.conversationId,
          kind: parsed.data.kind,
          summary: parsed.data.summary,
          sourceToolName: parsed.data.sourceToolName ?? null,
        });
        // Opportunistic prune so the table stays bounded for active convs.
        await pruneOldObservations(ctx.conversationId);
        return {
          ok: true,
          data: {
            kind: parsed.data.kind,
            summary: parsed.data.summary,
            recorded: true,
          },
        };
      }

      // V-Sub-3 — update_product_description, update_product_status,
      // create_product_draft MIGRATED to the Products department.
      // V-Sub-4 — update_product_price, create_discount MIGRATED to the
      // Pricing & Promotions department.
      // All write tools now belong to a department. Approval-time
      // dispatch happens in executeApprovedWrite below via the registry.

      case "delegate_to_department": {
        // V-Sub-1 — Phase Sub-Agents. Dispatch a focused sub-agent turn
        // for a department. The sub-agent returns either a summary
        // (kind=completed) or proposed writes (kind=proposed_writes).
        // For Sub-1 only the `_pilot` department is registered; real
        // departments (insights, products, pricing-promotions) come in
        // subsequent phases and the merchant-facing PendingAction
        // integration for proposed writes is wired in Sub-3 when
        // Products migrates.
        const parsed = DelegateToDepartmentInput.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, { code: "INVALID_INPUT", retryable: false });
        }
        const result = await runSubAgent({
          departmentId: parsed.data.department,
          task: parsed.data.task,
          conversationContext: parsed.data.conversationContext,
          context: {
            storeId: ctx.storeId,
            admin: ctx.admin,
            conversationId: ctx.conversationId,
          },
        });
        // Convert SubAgentResult into a tool_result the CEO can read.
        // Different result kinds get different shapes; the CEO's prompt
        // explains how to interpret them.
        const toolResult: ToolResult = {
          ok: true,
          data: {
            department: parsed.data.department,
            result,
          },
        };
        // Phase Re Round Re-C1 — advance the active plan's step pointer
        // when this delegation matches the current step's department.
        // Sub-agent kind:"error" is treated as failure for step purposes.
        const subAgentSucceeded =
          result.kind === "completed" ||
          result.kind === "proposed_writes" ||
          result.kind === "needs_clarification";
        const stepResult: ToolResult = subAgentSucceeded
          ? toolResult
          : fail(result.kind === "error" ? result.reason : "sub-agent failed", {
              code: (result.kind === "error" && result.code
                ? result.code
                : "UNKNOWN") as ErrorCode,
              retryable: false,
            });
        await tryAdvancePlanStep({
          storeId: ctx.storeId,
          conversationId: ctx.conversationId,
          toolDepartmentId: parsed.data.department,
          result: stepResult,
        });
        return toolResult;
      }

      case "delegate_parallel": {
        // Phase Wf Round Wf-D — fan out 2-5 read-only delegations
        // concurrently. Each sub-agent's tool list is filtered to
        // classification.read entries (allowOnlyReadOnly=true) — write
        // tools never reach the model, so this path can never race
        // against the approval flow. Result aggregates per-delegation
        // status; partial failures are surfaced rather than masked.
        const parsed = DelegateParallelInput.safeParse(input);
        if (!parsed.success) {
          return fail(`invalid input: ${parsed.error.message}`, {
            code: "INVALID_INPUT",
            retryable: false,
          });
        }
        const delegations = parsed.data.delegations;
        const results = await Promise.all(
          delegations.map(async (d) => {
            const r = await runSubAgent({
              departmentId: d.department,
              task: d.task,
              conversationContext: d.conversationContext,
              context: {
                storeId: ctx.storeId,
                admin: ctx.admin,
                conversationId: ctx.conversationId,
              },
              allowOnlyReadOnly: true,
            });
            return { department: d.department, task: d.task, result: r };
          }),
        );
        return {
          ok: true,
          data: {
            mode: "parallel-read-only",
            count: results.length,
            results,
          },
        };
      }

      default:
        return fail(`unknown tool: ${name}`, {
          code: "ID_NOT_FOUND",
          retryable: false,
        });
    }
  } catch (err) {
    return fail(err);
  }
}

// Snapshot the "before" state for AuditLog (CLAUDE.md rule #10). Returns null
// for create operations (nothing existed yet) or when the snapshot fetch fails
// — null is a valid before-snapshot meaning "no prior state".
export async function snapshotBefore(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown | null> {
  try {
    switch (toolName) {
      case "update_product_price":
      case "update_compare_at_price": {
        // V-PP-A — both share the same snapshot. fetchVariantPrice now
        // pulls compareAtPrice alongside price, so the AuditLog
        // before-state has both regardless of which tool fired.
        const variantId = String(toolInput.variantId ?? "");
        if (!variantId) return null;
        const r = await fetchVariantPrice(ctx.admin, variantId);
        return r.ok ? r.data : null;
      }
      // bulk_update_prices: no snapshotBefore — the result itself
      // returns per-variant {oldPrice, newPrice} in `changes[]`, so the
      // AuditLog's `after` field carries the full diff. Re-resolving
      // 50+ variants for a separate snapshot would double the read cost
      // for no extra value.
      //
      // V-Bulk-A — bulk_update_titles / bulk_update_tags / bulk_update_status
      // follow the SAME pattern. Each result includes per-product
      // {oldX, newX} in `changes[]`, so the AuditLog's after field carries
      // the full per-item diff. Falling through to default → null.
      case "update_discount":
      case "set_discount_status":
      case "delete_discount": {
        // V-PP-B — all three share fetchDiscount. AuditLog before-state
        // shows what existed pre-mutation; useful for reconstructing
        // a deleted or paused discount if the merchant changes their
        // mind.
        const discountId = String(toolInput.discountId ?? "");
        if (!discountId) return null;
        const r = await fetchDiscount(ctx.admin, discountId);
        return r.ok ? r.data : null;
      }
      case "update_product_description": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductDescription(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_product_status": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductStatus(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_product_title": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductTitle(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_product_tags": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductTags(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_product_vendor": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductVendor(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_product_type": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductType(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_variant": {
        const variantId = String(toolInput.variantId ?? "");
        if (!variantId) return null;
        const r = await fetchVariantDetails(ctx.admin, variantId);
        return r.ok ? r.data : null;
      }
      case "duplicate_product": {
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductForDuplicate(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_collection": {
        const collectionId = String(toolInput.collectionId ?? "");
        if (!collectionId) return null;
        const r = await fetchCollectionDetails(ctx.admin, collectionId);
        return r.ok ? r.data : null;
      }
      case "update_product_seo": {
        // V-Mkt-A — Marketing SEO writes share the seo.server snapshot
        // helpers. AuditLog before-state captures the pre-update SEO
        // title + description so the diff is meaningful even when one
        // field stays the same.
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductSeo(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "update_collection_seo": {
        const collectionId = String(toolInput.collectionId ?? "");
        if (!collectionId) return null;
        const r = await fetchCollectionSeo(ctx.admin, collectionId);
        return r.ok ? r.data : null;
      }
      case "update_article":
      case "delete_article": {
        // V-Mkt-B — both share fetchArticle. The before-state captures
        // the full article (title, body, summary, author, tags, image,
        // published flag, blog reference) so a deleted article can be
        // reconstructed from the AuditLog if the merchant regrets it.
        // delete_article runs a separate confirmTitle gate inside its
        // handler — that's about preventing the WRONG delete; this
        // snapshot is about preserving what existed if the right delete
        // is later regretted.
        const articleId = String(toolInput.articleId ?? "");
        if (!articleId) return null;
        const r = await fetchArticle(ctx.admin, articleId);
        return r.ok ? r.data : null;
      }
      case "update_page":
      case "delete_page": {
        // V-Mkt-C — Pages mirror articles. fetchPage snapshot preserves
        // the full body so a deleted policy page (Shipping / Returns /
        // Privacy) can be recovered from the AuditLog if the merchant
        // realizes they shouldn't have removed it.
        const pageId = String(toolInput.pageId ?? "");
        if (!pageId) return null;
        const r = await fetchPage(ctx.admin, pageId);
        return r.ok ? r.data : null;
      }
      case "update_customer":
      case "update_customer_tags":
      case "update_email_marketing_consent":
      case "update_sms_marketing_consent": {
        // V-Cu-A — All four customer writes share fetchCustomerDetail.
        // The snapshot captures identity + tags + note + email & SMS
        // consent state + lifetime stats. For consent writes especially
        // the before-state is legally meaningful: it's the prior consent
        // record that the merchant's mutation is REPLACING, and the
        // AuditLog row is the audit trail any privacy/compliance review
        // would consult. One canonical snapshot, all four writes.
        const customerId = String(toolInput.customerId ?? "");
        if (!customerId) return null;
        const r = await fetchCustomerDetail(ctx.admin, customerId);
        return r.ok ? r.data : null;
      }
      case "update_order_note":
      case "update_order_tags":
      case "mark_as_fulfilled":
      case "fulfill_order_with_tracking":
      case "cancel_order":
      case "refund_order": {
        // V-Or-B + V-Or-C + V-Or-D — All order writes share
        // fetchOrderDetail. Same canonical-snapshot pattern as customers:
        // one query, one shape, all order writes get the same
        // OrderDetail before-state in their AuditLog row. For cancel +
        // refund especially the before-state is legally meaningful: it
        // captures totalPrice + totalRefunded + totalRefundable + the
        // financial/fulfillment statuses that the mutation is about to
        // change. The AuditLog row is the audit trail any payment-
        // dispute review would consult.
        const orderId = String(toolInput.orderId ?? "");
        if (!orderId) return null;
        const r = await fetchOrderDetail(ctx.admin, orderId);
        return r.ok ? r.data : null;
      }
      case "remove_product_image":
      case "reorder_product_images": {
        // Both: AuditLog before-state is the current media listing for
        // the product. For remove, the diff shows which media id is
        // gone after; for reorder, it shows the before-and-after order.
        const productId = String(toolInput.productId ?? "");
        if (!productId) return null;
        const r = await fetchProductMedia(ctx.admin, productId);
        return r.ok ? r.data : null;
      }
      case "set_inventory_tracking":
      case "adjust_inventory_quantity":
      case "set_inventory_quantity":
      case "transfer_inventory": {
        // V-Inv-A + V-Inv-B — All four inventory writes share
        // fetchInventoryLevels. The snapshot captures the inventory
        // item's identity (sku, barcode), tracked flag, and per-location
        // available quantities. For tracking flips, the snapshot
        // preserves the pre-toggle stock context. For adjust / set, it
        // shows the merchant the current per-location available count
        // so the ApprovalCard can render current → new. For transfer,
        // both source AND destination locations are in the same shape
        // so the diff captures both ends of the move.
        const inventoryItemId = String(toolInput.inventoryItemId ?? "");
        if (!inventoryItemId) return null;
        const r = await fetchInventoryLevels(ctx.admin, inventoryItemId);
        return r.ok ? r.data : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// WRITE tools, dispatched from the approve route only.
export async function executeApprovedWrite(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    let result: ToolResult;

    // V-Sub-3 — registry-driven dispatch. If the tool has been migrated
    // to a department module (registry knows its owner), route through
    // the department's handler. Falls through to the legacy switch for
    // unmigrated tools. The legacy switch shrinks each migration phase;
    // Sub-5 retires it entirely once all writes are migrated.
    const ownerDepartmentId = departmentForTool(name);
    if (ownerDepartmentId) {
      const spec = getDepartmentSpec(ownerDepartmentId);
      const handler = spec?.handlers.get(name);
      if (!spec || !handler) {
        return fail(
          `Tool '${name}' is owned by department '${ownerDepartmentId}' but no handler is registered. Registry inconsistency.`,
          { code: "UNKNOWN", retryable: false },
        );
      }
      result = coerceHandlerResult(await handler(input, ctx));
    } else {
      // V-Sub-5 — every write tool is department-owned. If we reach this
      // branch it means departmentForTool returned null for `name`, which
      // can only happen if Gemini hallucinated a tool name OR a department
      // module wasn't imported in registry-entrypoint.server.ts. Both are
      // bugs upstream; surface a clear error so they're easy to diagnose.
      return fail(
        `unknown write tool: ${name}. No department in the registry owns it. Either the model hallucinated the name or the department module isn't imported in registry-entrypoint.server.ts.`,
        { code: "ID_NOT_FOUND", retryable: false },
      );
    }

    // V2.4 — invalidate the read cache after any successful write so
    // subsequent reads in the same conversation see fresh state. The
    // 5-min TTL would catch this eventually, but cache-on-stale-write
    // is bad UX (CEO confidently quotes the OLD price right after
    // approving the NEW one). Coarse invalidation: drop everything
    // cached for the conversation rather than try to map fields →
    // affected entities.
    // Phase Re Round Re-C1 — advance the active plan's step pointer
    // when the dispatched write tool's department matches the current
    // step's department. Best-effort + tolerant of "no plan in scope"
    // (most writes happen outside any plan). Done BEFORE cache
    // invalidation so the step state reflects the in-flight result.
    await tryAdvancePlanStep({
      storeId: ctx.storeId,
      conversationId: ctx.conversationId,
      toolDepartmentId: ownerDepartmentId,
      result,
    });

    if (result.ok && ctx.conversationId) {
      readCacheInvalidate(ctx.conversationId, [
        "read_products",
        "read_collections",
        "get_analytics",
        // V-PP-A — discount writes (create_discount, future
        // update/pause/delete in Round B) bust the read_discounts
        // cache so the CEO sees fresh state on the next list query.
        // Price writes (update_product_price, bulk_update_prices,
        // update_compare_at_price) also bust read_products which
        // surfaces variant prices.
        "read_discounts",
        // V-IN-A — Insights deepening. Product / inventory writes
        // can affect per-product performance numbers (price changes
        // shift revenue per order; status changes affect what's
        // visible in top performers). Bust the new caches too so
        // the next analytics question gets fresh state.
        "get_product_performance",
        "compare_periods",
        // V-IN-B — Same rationale: writes shift the rankings.
        "get_top_performers",
        // V-Mkt-B — article writes (create_article / update_article /
        // delete_article) bust the read_articles cache so the next
        // listing reflects the new state immediately.
        "read_articles",
        // V-Mkt-C — same rationale for static pages.
        "read_pages",
        // V-Cu-A — Customer writes shift list-level fields (tags,
        // consent, identity) that read_customers surfaces, AND the
        // detail-level snapshot that read_customer_detail returns.
        // Bust both so post-write reads in the same conversation see
        // fresh state.
        "read_customers",
        "read_customer_detail",
        // V-Cu-B — Customer writes can shift SEGMENT membership too:
        // tag changes affect tag-based segments, consent changes
        // affect subscriber-based segments, etc. Bust the segment
        // reads so a "show me my VIPs" follow-up after an
        // update_customer_tags call doesn't return stale membership.
        "read_segments",
        "read_segment_members",
        // V-Or-B — Order writes shift list-level fields (tags) and
        // detail-level fields (note + tags). Bust both order reads so
        // a post-write "show me unfulfilled orders" or "tell me about
        // #1001 again" returns fresh state.
        "read_orders",
        "read_order_detail",
        // V-Inv-A — Inventory writes shift the tracked flag (and in
        // Round B will shift quantities) that read_inventory_levels
        // surfaces. Bust read_inventory_levels so a post-write "how
        // much do I have now?" returns fresh state. read_locations
        // is NOT busted — locations don't change from inventory
        // writes.
        "read_inventory_levels",
      ]);
    }
    return result;
  } catch (err) {
    return fail(err);
  }
}
