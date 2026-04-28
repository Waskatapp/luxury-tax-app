import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  approvePlan,
  findPlanByToolCallId,
  planAuditPayload,
} from "../lib/agent/plans.server";

// V2.3 — POST /api/plan-approve. Approves a propose_plan tool_use that was
// rendered as PlanCard in the chat. After approval, the client triggers
// continueChat → Gemini sees the synthesized tool_result with
// `{approved: true}` and proceeds to execute the plan's steps. Each WRITE
// step still goes through its own ApprovalCard (no bypass).

const BodySchema = z.object({
  toolCallId: z.string().min(1).max(120),
});

// The synthesized tool_result block shape Gemini reads on continuation.
// Mirrors the approve-batch pattern: status + per-tool-call mapping. Plan
// approval is single-row by definition (one plan per tool_use), so the
// shape is simpler than the multi-write batch case.
function buildApprovedToolResult(toolCallId: string, planId: string) {
  return [
    {
      type: "tool_result" as const,
      tool_use_id: toolCallId,
      content: JSON.stringify({
        approved: true,
        planId,
        note: "The merchant approved this plan. Proceed step-by-step. Each WRITE step still requires its own approval card — call the relevant write tool and wait for the merchant before moving on.",
      }),
    },
  ];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { toolCallId } = parsed.data;

  // Tenant-scoped lookup. findPlanByToolCallId already filters by storeId,
  // so a stale id from another store can't approve our plans.
  const plan = await findPlanByToolCallId(store.id, toolCallId);
  if (!plan) return new Response("Not found", { status: 404 });

  const flip = await approvePlan(store.id, toolCallId);
  if (!flip.ok) {
    return Response.json({ ok: false, error: flip.reason }, { status: 409 });
  }

  // Re-read so the audit row reflects the post-flip state.
  const after = await findPlanByToolCallId(store.id, toolCallId);

  const toolResultBlocks = buildApprovedToolResult(toolCallId, plan.id);

  // ONE transaction: AuditLog + synth Message + conversation timestamp bump.
  // Skip the AuditLog when alreadyDone (a duplicate click) so the log isn't
  // spammed by retry-induced double-approves.
  const txOps: Prisma.PrismaPromise<unknown>[] = [];
  if (!flip.alreadyDone) {
    txOps.push(
      prisma.auditLog.create({
        data: {
          storeId: store.id,
          action: "plan_approved",
          toolName: "propose_plan",
          before: planAuditPayload(plan) as never,
          after: (after ? planAuditPayload(after) : null) as never,
        },
      }),
    );
  }
  txOps.push(
    prisma.message.create({
      data: {
        conversationId: plan.conversationId,
        role: "user",
        content: toolResultBlocks as unknown as object,
      },
    }),
  );
  txOps.push(
    prisma.conversation.update({
      where: { id: plan.conversationId },
      data: { updatedAt: new Date() },
    }),
  );
  await prisma.$transaction(txOps);

  return Response.json({
    ok: true,
    status: flip.status,
    alreadyDone: flip.alreadyDone,
    conversationId: plan.conversationId,
  });
};
