// V-Sub-4 — all write executors migrated to department modules
// (Products, Pricing & Promotions). We still import the snapshot
// helpers (fetchProductDescription, fetchProductStatus, fetchVariantPrice)
// because snapshotBefore() builds AuditLog pre-state by tool name
// regardless of which department owns the executor — keeping the
// snapshot logic centralized avoids duplicating it across departments.
import {
  fetchProductDescription,
  fetchProductForDuplicate,
  fetchProductStatus,
  fetchProductTags,
  fetchProductTitle,
  fetchProductType,
  fetchProductVendor,
  fetchVariantDetails,
} from "../shopify/products.server";
import { fetchVariantPrice } from "../shopify/pricing.server";
// V-Sub-2 — getAnalytics import removed: get_analytics migrated to the
// Insights department (app/lib/agent/departments/insights/). The
// underlying app/lib/shopify/analytics.server.ts module is unchanged;
// only the central executor no longer routes to it directly.
import type { ShopifyAdmin } from "../shopify/graphql-client.server";
import { upsertMemory } from "../memory/store-memory.server";
import {
  ProposePlanInputSchema,
  findPlanById,
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

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

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
          return {
            ok: false,
            error: `invalid input: ${parsed.error.message}`,
          };
        }
        const body = loadWorkflowBodyByName(parsed.data.name);
        if (body === null) {
          return {
            ok: false,
            error: `unknown workflow: '${parsed.data.name}'. Check the workflow index in your system prompt for valid names.`,
          };
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
          return {
            ok: false,
            error:
              "propose_plan requires conversationId + toolCallId in context — this is an internal wiring bug, not a tool input issue",
          };
        }
        const parsed = ProposePlanInputSchema.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: `invalid input: ${parsed.error.message}` };
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
            return {
              ok: false,
              error: `parentPlanId '${parsed.data.parentPlanId}' not found in this store. If you're replanning, double-check the original plan's id from the prior tool_result. Otherwise, omit parentPlanId for a fresh plan.`,
            };
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
          return {
            ok: false,
            error:
              "could not persist the plan; if this happens again, ask the merchant to retry the request",
          };
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
          return {
            ok: false,
            error:
              "propose_artifact requires conversationId + toolCallId in context — this is an internal wiring bug, not a tool input issue",
          };
        }
        const parsed = ProposeArtifactInputSchema.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: `invalid input: ${parsed.error.message}` };
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
          return {
            ok: false,
            error:
              "could not persist the artifact; if this happens again, ask the merchant to retry the request",
          };
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
          return { ok: false, error: `invalid input: ${parsed.error.message}` };
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
          return {
            ok: false,
            error:
              "could not persist the followup; if this happens again, ask the merchant to retry the request",
          };
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
          return { ok: false, error: `invalid input: ${parsed.error.message}` };
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
          return { ok: false, error: `invalid input: ${parsed.error.message}` };
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
          return { ok: false, error: `invalid input: ${parsed.error.message}` };
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
        return {
          ok: true,
          data: {
            department: parsed.data.department,
            result,
          },
        };
      }

      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
      case "update_product_price": {
        const variantId = String(toolInput.variantId ?? "");
        if (!variantId) return null;
        const r = await fetchVariantPrice(ctx.admin, variantId);
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
        return {
          ok: false,
          error: `Tool '${name}' is owned by department '${ownerDepartmentId}' but no handler is registered. Registry inconsistency.`,
        };
      }
      result = await handler(input, ctx);
    } else {
      // V-Sub-5 — every write tool is department-owned. If we reach this
      // branch it means departmentForTool returned null for `name`, which
      // can only happen if Gemini hallucinated a tool name OR a department
      // module wasn't imported in registry-entrypoint.server.ts. Both are
      // bugs upstream; surface a clear error so they're easy to diagnose.
      return {
        ok: false,
        error: `unknown write tool: ${name}. No department in the registry owns it. Either the model hallucinated the name or the department module isn't imported in registry-entrypoint.server.ts.`,
      };
    }

    // V2.4 — invalidate the read cache after any successful write so
    // subsequent reads in the same conversation see fresh state. The
    // 5-min TTL would catch this eventually, but cache-on-stale-write
    // is bad UX (CEO confidently quotes the OLD price right after
    // approving the NEW one). Coarse invalidation: drop everything
    // cached for the conversation rather than try to map fields →
    // affected entities.
    if (result.ok && ctx.conversationId) {
      readCacheInvalidate(ctx.conversationId, [
        "read_products",
        "read_collections",
        "get_analytics",
      ]);
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
