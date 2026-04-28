import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { listPlansForConversation } from "../lib/agent/plans.server";
import { listDraftArtifactsForConversation } from "../lib/agent/artifacts.server";

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
  // internal plumbing between agent turns. Exception: get_analytics tool_results
  // surface as inline DataTable cards (Phase 9), so we keep those rows visible.
  const visible = rows.filter((m) => {
    const blocks = m.content as unknown as Array<{
      type?: string;
      tool_use_id?: string;
    }> | null;
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    if (m.role === "user" && blocks.every((b) => b?.type === "tool_result")) {
      const hasAnalytics = blocks.some((b) =>
        typeof b?.tool_use_id === "string" &&
        b.tool_use_id.startsWith("get_analytics::"),
      );
      if (!hasAnalytics) return false;
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

  // V2.3 — same pattern for Plan rows. PlanCard reads
  // `planByToolCallId[toolCallId]` to know whether to show Approve/Reject
  // buttons (status === "PENDING") or a terminal status badge.
  const plans = await listPlansForConversation(store.id, conversationId);
  const planByToolCallId: Record<
    string,
    {
      id: string;
      summary: string;
      steps: { description: string; departmentId: string; estimatedTool?: string | undefined }[];
      status: "PENDING" | "APPROVED" | "REJECTED";
    }
  > = {};
  for (const p of plans) {
    planByToolCallId[p.toolCallId] = {
      id: p.id,
      summary: p.summary,
      steps: p.steps,
      status: p.status,
    };
  }

  // V2.5 — same pattern for Artifact DRAFT rows. The chat reducer reads
  // `draftArtifacts` and reopens the side panel for the latest one if
  // the merchant reloads mid-edit. Only DRAFT rows are returned —
  // approved / discarded artifacts shouldn't reopen the panel.
  const drafts = await listDraftArtifactsForConversation(
    store.id,
    conversationId,
  );
  const draftArtifacts = drafts.map((a) => ({
    id: a.id,
    toolCallId: a.toolCallId,
    kind: a.kind,
    productId: a.content.productId,
    productTitle: a.content.productTitle,
    content: a.content.html,
    updatedAt: a.updatedAt,
  }));

  return {
    messages: visible.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      status: "complete" as const,
    })),
    pendingByToolCallId,
    planByToolCallId,
    draftArtifacts,
  };
};
