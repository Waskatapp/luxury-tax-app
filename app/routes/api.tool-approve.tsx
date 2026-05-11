import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  executeApprovedWrite,
  snapshotBefore,
  withRetry,
} from "../lib/agent/executor.server";
import { classifyError } from "../lib/agent/error-codes";
import {
  pruneOldFailures,
  recordFailure,
} from "../lib/agent/conversation-failures.server";
import {
  buildApproveToolResults,
  processApproveBatch,
  summarizeBatchOutcome,
  validateBatch,
  type PendingRow,
} from "../lib/agent/approval-batch";
import { promoteWriteTurnSignal } from "../lib/agent/turn-signals.server";

// V1.8 batch-approve: accept either { toolCallId } (legacy single) or
// { toolCallIds: [...] } (batch). The single shape is kept for backwards
// compatibility but the client always sends an array now.
const BodySchema = z.union([
  z.object({ toolCallId: z.string().min(1) }),
  z.object({ toolCallIds: z.array(z.string().min(1)).min(1).max(8) }),
]);

// POST /api/tool-approve — execute a batch of PendingActions sequentially.
//
// Per CLAUDE.md §5, §8 — no parallel writes. The orchestration logic lives
// in approval-batch.ts (pure helpers, unit-testable); this route file is
// the prisma + auth boundary.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { admin, store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });

  const toolCallIds: string[] =
    "toolCallIds" in parsed.data
      ? parsed.data.toolCallIds
      : [parsed.data.toolCallId];

  // One up-front lookup verifies all rows exist + tenant + share one
  // conversationId. Cross-tenant / cross-conversation requests fail fast.
  const dbRows = await prisma.pendingAction.findMany({
    where: { toolCallId: { in: toolCallIds }, storeId: store.id },
    select: {
      id: true,
      toolCallId: true,
      conversationId: true,
      toolName: true,
      toolInput: true,
      brief: true,
      status: true,
    },
  });
  if (dbRows.length === 0) return new Response("Not found", { status: 404 });

  const rows: PendingRow[] = dbRows.map((r) => ({
    id: r.id,
    toolCallId: r.toolCallId,
    conversationId: r.conversationId,
    toolName: r.toolName,
    toolInput: (r.toolInput ?? {}) as Record<string, unknown> | null,
    brief: r.brief,
    status: r.status as PendingRow["status"],
  }));

  const validation = validateBatch(rows);
  if (!validation.ok) return new Response(validation.reason, { status: 400 });
  const conversationId = validation.conversationId;

  const rowByCallId = new Map(rows.map((r) => [r.toolCallId, r]));

  const { processed, responseResults } = await processApproveBatch({
    toolCallIds,
    rowByCallId,
    flipPending: async (id) =>
      prisma.pendingAction.updateMany({
        where: { toolCallId: id, storeId: store.id, status: "PENDING" },
        data: { status: "APPROVED" },
      }),
    snapshot: (toolName, toolInput) =>
      snapshotBefore(toolName, toolInput, { admin, storeId: store.id }),
    execute: (toolName, toolInput) =>
      // V2.4 — thread conversationId so executeApprovedWrite can
      // invalidate this conversation's read cache after a successful
      // mutation.
      // Phase Re Round Re-B — wrap in withRetry so transient failures
      // (Shopify 429, network) on idempotent tools auto-recover before
      // returning a failure to the merchant. This route is non-streaming
      // so no SSE notifier — retry happens silently within the request.
      withRetry(toolName, () =>
        executeApprovedWrite(toolName, toolInput, {
          admin,
          storeId: store.id,
          conversationId,
        }),
      ),
  });

  const toolResultBlocks = buildApproveToolResults(processed);

  // Phase Wf Round Wf-C — record approved-write failures so the next chat
  // turn's failureLessonsAugmenter surfaces them. Best-effort. The
  // approval-batch API doesn't carry the structured ErrorCode through, so
  // we re-classify the error string here. Same dedupe + prune pattern as
  // the inline-tool path in agent-loop.server.ts.
  for (const p of processed) {
    if (p.skip || !p.error) continue;
    const classified = classifyError(p.error);
    await recordFailure({
      storeId: store.id,
      conversationId,
      toolName: p.toolName,
      code: classified.code,
      errorMessage: p.error,
    });
  }
  if (processed.some((p) => !p.skip && p.error)) {
    await pruneOldFailures(conversationId);
  }

  // ONE transaction containing every per-row update + per-row audit entry +
  // the consolidated synth Message + the conversation timestamp bump.
  const txOps: Prisma.PrismaPromise<unknown>[] = [];
  for (const p of processed) {
    if (!p.skip) {
      txOps.push(
        prisma.pendingAction.update({
          where: { id: p.pendingId },
          data: {
            status: p.finalStatus,
            beforeSnapshot: (p.before ?? null) as never,
          },
        }),
      );
      txOps.push(
        prisma.auditLog.create({
          data: {
            storeId: store.id,
            action: p.error ? "tool_failed" : "tool_executed",
            toolName: p.toolName,
            brief: p.brief,
            before: (p.before ?? null) as never,
            after: (p.after ?? (p.error ? { error: p.error } : null)) as never,
          },
        }),
      );
    }
  }
  // Always create the synth Message + bump conversation, even if every row
  // was a skip — the client still expects a continuation turn after a click.
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

  const { ok } = summarizeBatchOutcome(responseResults);

  // V2.2 — promote the TurnSignal that triggered this approval from
  // "informational" to "approved" (or "rejected" when nothing actually
  // executed — typically every row was already terminal). Failure here
  // is silent (logged) so the merchant's UX is unaffected.
  const anyExecuted = processed.some((p) => !p.skip && !p.error);
  await promoteWriteTurnSignal({
    storeId: store.id,
    conversationId,
    outcome: anyExecuted ? "approved" : "rejected",
  });

  return Response.json({
    ok,
    results: responseResults,
    conversationId,
  });
};
