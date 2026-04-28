import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  buildRejectToolResults,
  processRejectBatch,
  validateBatch,
  type PendingRow,
} from "../lib/agent/approval-batch";
import { promoteWriteTurnSignal } from "../lib/agent/turn-signals.server";

const BodySchema = z.union([
  z.object({ toolCallId: z.string().min(1) }),
  z.object({ toolCallIds: z.array(z.string().min(1)).min(1).max(8) }),
]);

// POST /api/tool-reject — record merchant rejection of a batch of PendingActions.
//
// Per-row flip PENDING → REJECTED via updateMany; AuditLog "tool_rejected" with
// before/after = null per row; ONE synthetic user Message containing N tool_result
// blocks (each shaped { rejected: true, reason }) so Gemini sees one well-formed
// user turn on continuation.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });

  const toolCallIds: string[] =
    "toolCallIds" in parsed.data
      ? parsed.data.toolCallIds
      : [parsed.data.toolCallId];

  const dbRows = await prisma.pendingAction.findMany({
    where: { toolCallId: { in: toolCallIds }, storeId: store.id },
    select: {
      id: true,
      toolCallId: true,
      conversationId: true,
      toolName: true,
      status: true,
    },
  });
  if (dbRows.length === 0) return new Response("Not found", { status: 404 });

  const rows: PendingRow[] = dbRows.map((r) => ({
    id: r.id,
    toolCallId: r.toolCallId,
    conversationId: r.conversationId,
    toolName: r.toolName,
    toolInput: null,
    status: r.status as PendingRow["status"],
  }));

  const validation = validateBatch(rows);
  if (!validation.ok) return new Response(validation.reason, { status: 400 });
  const conversationId = validation.conversationId;

  const rowByCallId = new Map(rows.map((r) => [r.toolCallId, r]));

  const { processed, responseResults } = await processRejectBatch({
    toolCallIds,
    rowByCallId,
    flipPending: async (id) =>
      prisma.pendingAction.updateMany({
        where: { toolCallId: id, storeId: store.id, status: "PENDING" },
        data: { status: "REJECTED" },
      }),
  });

  const toolResultBlocks = buildRejectToolResults(processed);

  const txOps: Prisma.PrismaPromise<unknown>[] = [];
  for (const p of processed) {
    if (!p.skip) {
      txOps.push(
        prisma.auditLog.create({
          data: {
            storeId: store.id,
            action: "tool_rejected",
            toolName: p.toolName,
            before: null as never,
            after: null as never,
          },
        }),
      );
    }
  }
  txOps.push(
    prisma.message.create({
      data: {
        conversationId,
        role: "user",
        content: toolResultBlocks as unknown as object,
      },
    }),
  );
  txOps.push(
    prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  );

  await prisma.$transaction(txOps);

  // V2.2 — promote the TurnSignal that triggered this rejection from
  // "informational" to "rejected". Failure here is silent (logged) so
  // the merchant's UX is unaffected.
  await promoteWriteTurnSignal({
    storeId: store.id,
    conversationId,
    outcome: "rejected",
  });

  return Response.json({
    ok: true,
    results: responseResults,
    conversationId,
  });
};
