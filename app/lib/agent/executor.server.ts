import {
  createProductDraft,
  fetchProductDescription,
  fetchProductStatus,
  readProducts,
  updateProductDescription,
  updateProductStatus,
} from "../shopify/products.server";
import {
  fetchVariantPrice,
  updateProductPrice,
} from "../shopify/pricing.server";
import { createDiscount } from "../shopify/discounts.server";
import { readCollections } from "../shopify/collections.server";
import { getAnalytics } from "../shopify/analytics.server";
import type { ShopifyAdmin } from "../shopify/graphql-client.server";
import { upsertMemory } from "../memory/store-memory.server";
import {
  ProposePlanInputSchema,
  safeCreatePlan,
} from "./plans.server";
import {
  ProposeArtifactInputSchema,
  safeCreateArtifact,
  artifactSummary,
} from "./artifacts.server";
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
    .regex(/^[a-z0-9_]+$/, "key must be snake_case"),
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
      case "read_products": {
        const result = await readProducts(ctx.admin, input);
        if (result.ok && ctx.conversationId) {
          readCacheSet(ctx.conversationId, name, input, result.data);
        }
        return result;
      }

      case "read_collections": {
        const result = await readCollections(ctx.admin, input);
        if (result.ok && ctx.conversationId) {
          readCacheSet(ctx.conversationId, name, input, result.data);
        }
        return result;
      }

      case "get_analytics": {
        const result = await getAnalytics(ctx.admin, input);
        if (result.ok && ctx.conversationId) {
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
        const plan = await safeCreatePlan({
          storeId: ctx.storeId,
          conversationId: ctx.conversationId,
          toolCallId: ctx.toolCallId,
          summary: parsed.data.summary,
          steps: parsed.data.steps,
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
            summary: plan.summary,
            steps: plan.steps,
            status: plan.status,
            note: "Plan persisted. Wait for the merchant's approval before executing any of these steps. Each WRITE step will still get its own approval card when you call its tool.",
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

      case "update_product_price":
      case "update_product_description":
      case "update_product_status":
      case "create_product_draft":
      case "create_discount":
        return {
          ok: false,
          error: `${name} must route through the approval flow. executeTool should not be called for write tools.`,
        };

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
    switch (name) {
      case "update_product_price":
        result = await updateProductPrice(ctx.admin, input);
        break;
      case "update_product_description":
        result = await updateProductDescription(ctx.admin, input);
        break;
      case "update_product_status":
        result = await updateProductStatus(ctx.admin, input);
        break;
      case "create_product_draft":
        result = await createProductDraft(ctx.admin, input);
        break;
      case "create_discount":
        result = await createDiscount(ctx.admin, input);
        break;
      default:
        return { ok: false, error: `unknown write tool: ${name}` };
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
