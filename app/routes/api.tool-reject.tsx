import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import type { ContentBlock } from "../lib/agent/translate.server";

const BodySchema = z.object({
  toolCallId: z.string().min(1),
});

// POST /api/tool-reject — record a merchant rejection of a PendingAction.
// Atomic flip PENDING → REJECTED; AuditLog with null `after`; synthesized
// tool_result Message so Gemini knows on continuation.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { toolCallId } = parsed.data;

  const flipped = await prisma.pendingAction.updateMany({
    where: { toolCallId, storeId: store.id, status: "PENDING" },
    data: { status: "REJECTED" },
  });
  if (flipped.count === 0) {
    const existing = await prisma.pendingAction.findFirst({
      where: { toolCallId, storeId: store.id },
      select: { id: true, status: true, conversationId: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });
    return Response.json(
      {
        ok: false,
        error: `already ${existing.status.toLowerCase()}`,
        conversationId: existing.conversationId,
      },
      { status: 409 },
    );
  }

  const pending = await prisma.pendingAction.findFirst({
    where: { toolCallId, storeId: store.id },
    select: { id: true, conversationId: true, toolName: true },
  });
  if (!pending) return new Response("Not found", { status: 404 });

  const toolResultBlock: ContentBlock = {
    type: "tool_result",
    tool_use_id: toolCallId,
    content: JSON.stringify({
      rejected: true,
      reason: "merchant rejected the action; no change was made",
    }),
    is_error: false,
  };

  await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        storeId: store.id,
        action: "tool_rejected",
        toolName: pending.toolName,
        before: null as never,
        after: null as never,
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
    ok: true,
    conversationId: pending.conversationId,
    toolCallId,
    status: "REJECTED",
  });
};
