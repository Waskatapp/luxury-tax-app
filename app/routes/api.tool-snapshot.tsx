import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { snapshotBefore } from "../lib/agent/executor.server";
import {
  buildProductAdminUrl,
  extractProductIdFromSnapshot,
  extractProductTitleFromSnapshot,
} from "../lib/shopify/admin-url";

// GET /api/tool-snapshot?toolCallId=X
//
// Returns the current Shopify state for the entity a PendingAction is about
// to mutate, plus enough metadata for the ApprovalCard to render a friendly
// summary line ("Set price for [cat food ↗] to $50.00") instead of raw GIDs.
//
// Re-uses `snapshotBefore` so the "before" the merchant sees in the diff is
// the same snapshot persisted on approval. Adds:
//   - productTitle: human-readable name pulled from the snapshot, or null
//   - productId:    GID of the product (for tools that reference one)
//   - adminUrl:     full https://admin.shopify.com/... product URL, or null
//
// Returns null `before` for create_* tools and on any fetch failure — the
// card hides the diff block in that case. The other fields degrade
// gracefully too: missing data → null → card falls back to the raw form.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, store } = await requireStoreAccess(request);

  const url = new URL(request.url);
  const toolCallId = url.searchParams.get("toolCallId");
  if (!toolCallId) return new Response("Missing toolCallId", { status: 400 });

  const pending = await prisma.pendingAction.findFirst({
    where: { toolCallId, storeId: store.id },
    select: {
      toolName: true,
      toolInput: true,
    },
  });
  if (!pending) return new Response("Not found", { status: 404 });

  const toolInput = (pending.toolInput ?? {}) as Record<string, unknown>;
  const before = await snapshotBefore(pending.toolName, toolInput, {
    admin,
    storeId: store.id,
  });

  const productTitle = extractProductTitleFromSnapshot(before);
  const productId = extractProductIdFromSnapshot(
    pending.toolName,
    before,
    toolInput,
  );
  const adminUrl = buildProductAdminUrl(store.shopDomain, productId);

  return Response.json({
    toolName: pending.toolName,
    before,
    productTitle,
    productId,
    adminUrl,
  });
};
