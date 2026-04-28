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
    switch (name) {
      case "read_products":
        return await readProducts(ctx.admin, input);

      case "read_collections":
        return await readCollections(ctx.admin, input);

      case "get_analytics":
        return await getAnalytics(ctx.admin, input);

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
    switch (name) {
      case "update_product_price":
        return await updateProductPrice(ctx.admin, input);
      case "update_product_description":
        return await updateProductDescription(ctx.admin, input);
      case "update_product_status":
        return await updateProductStatus(ctx.admin, input);
      case "create_product_draft":
        return await createProductDraft(ctx.admin, input);
      case "create_discount":
        return await createDiscount(ctx.admin, input);
      default:
        return { ok: false, error: `unknown write tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
