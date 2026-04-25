import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";

// GET /api/messages?conversationId=X → messages for a conversation (tenant-scoped).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) return new Response("Missing conversationId", { status: 400 });

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, storeId: store.id },
    select: { id: true },
  });
  if (!conversation) return new Response("Not found", { status: 404 });

  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, createdAt: true },
  });

  // Hide "synthetic" user rows that only carry tool_result blocks — these are
  // internal plumbing between agent turns, not something the merchant wrote.
  const visible = rows.filter((m) => {
    const blocks = m.content as unknown as Array<{ type?: string }> | null;
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    if (m.role === "user" && blocks.every((b) => b?.type === "tool_result")) {
      return false;
    }
    return true;
  });

  // Pending-action status sidecar so ApprovalCards know whether to show
  // Approve/Reject buttons or "Approved" / "Rejected" badges on reload.
  const pending = await prisma.pendingAction.findMany({
    where: { conversationId, storeId: store.id },
    select: { toolCallId: true, status: true },
  });
  const pendingByToolCallId: Record<string, string> = {};
  for (const p of pending) pendingByToolCallId[p.toolCallId] = p.status;

  return {
    messages: visible.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      status: "complete" as const,
    })),
    pendingByToolCallId,
  };
};
