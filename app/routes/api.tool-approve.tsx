import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  executeApprovedWrite,
  snapshotBefore,
} from "../lib/agent/executor.server";
import type { ContentBlock } from "../lib/agent/translate.server";

const BodySchema = z.object({
  toolCallId: z.string().min(1),
});

// POST /api/tool-approve — execute a PendingAction the merchant just approved.
//
// Flow (per CLAUDE.md §5):
//   1. Atomic status flip PENDING → APPROVED via updateMany. If 0 rows match,
//      another tab already processed this; return 409 idempotently.
//   2. Snapshot "before" state (Rule #10).
//   3. Execute the Shopify mutation.
//   4. In one transaction: update PendingAction → EXECUTED (or FAILED), insert
//      AuditLog with before+after, persist a synthetic user-with-tool_result
//      Message so Gemini sees the outcome on its next turn.
//   5. Return { ok, conversationId } so the client can trigger the
//      continuation chat call.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { admin, store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { toolCallId } = parsed.data;

  // Atomic flip: only the first concurrent caller succeeds.
  const flipped = await prisma.pendingAction.updateMany({
    where: { toolCallId, storeId: store.id, status: "PENDING" },
    data: { status: "APPROVED" },
  });
  if (flipped.count === 0) {
    const existing = await prisma.pendingAction.findFirst({
      where: { toolCallId, storeId: store.id },
      select: { id: true, status: true, conversationId: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });
    return Response.json(
      { ok: false, error: `already ${existing.status.toLowerCase()}`, conversationId: existing.conversationId },
      { status: 409 },
    );
  }

  const pending = await prisma.pendingAction.findFirst({
    where: { toolCallId, storeId: store.id },
    select: {
      id: true,
      conversationId: true,
      toolName: true,
      toolInput: true,
    },
  });
  if (!pending) return new Response("Not found", { status: 404 });

  const toolInput = (pending.toolInput ?? {}) as Record<string, unknown>;

  // Snapshot before for AuditLog (best-effort — null is acceptable).
  const before = await snapshotBefore(pending.toolName, toolInput, {
    admin,
    storeId: store.id,
  });

  // Execute the Shopify mutation.
  const result = await executeApprovedWrite(pending.toolName, toolInput, {
    admin,
    storeId: store.id,
  });

  // Build the synthetic user-with-tool_result Message so Gemini sees the
  // outcome on its next turn. api.messages filters this row from the UI.
  const toolResultBlock: ContentBlock = {
    type: "tool_result",
    tool_use_id: toolCallId,
    content: JSON.stringify(
      result.ok ? result.data : { error: result.error },
    ),
    is_error: !result.ok,
  };

  const finalStatus = result.ok ? "EXECUTED" : "FAILED";
  const auditAction = result.ok ? "tool_executed" : "tool_failed";
  const after = result.ok ? (result.data ?? null) : null;

  await prisma.$transaction([
    prisma.pendingAction.update({
      where: { id: pending.id },
      data: {
        status: finalStatus,
        beforeSnapshot: (before ?? null) as never,
      },
    }),
    prisma.auditLog.create({
      data: {
        storeId: store.id,
        action: auditAction,
        toolName: pending.toolName,
        before: (before ?? null) as never,
        after: (after ?? (result.ok ? null : { error: result.error })) as never,
      },
    }),
    prisma.message.create({
      data: {
        conversationId: pending.conversationId,
        role: "user",
        content: [toolResultBlock] as unknown as object,
      },
    }),
    prisma.conversation.update({
      where: { id: pending.conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  return Response.json({
    ok: result.ok,
    error: result.ok ? null : result.error,
    conversationId: pending.conversationId,
    toolCallId,
    status: finalStatus,
  });
};
