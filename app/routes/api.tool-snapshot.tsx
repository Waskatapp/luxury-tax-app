import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { snapshotBefore } from "../lib/agent/executor.server";

// GET /api/tool-snapshot?toolCallId=X
//
// Returns the current Shopify state for the entity a PendingAction is about
// to mutate, so ApprovalCard can render a before/after diff. Re-uses the
// same `snapshotBefore` helper that api.tool-approve calls when writing the
// AuditLog row, so the "before" the merchant sees in the card is the same
// snapshot persisted on approval.
//
// Returns null `before` for create_* tools (no prior state) and on any
// fetch failure — the card hides the diff block in that case.
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

  return Response.json({
    toolName: pending.toolName,
    before,
  });
};
