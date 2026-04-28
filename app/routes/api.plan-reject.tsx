import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  findPlanByToolCallId,
  planAuditPayload,
  rejectPlan,
} from "../lib/agent/plans.server";

// V2.3 — POST /api/plan-reject. Mirrors api.plan-approve.tsx; the only
// difference is the synthesized tool_result body and the audit action name.
// On reject the merchant is telling the CEO "don't do any of this." The
// CEO's continuation summary should acknowledge the rejection without
// trying to execute steps.

const BodySchema = z.object({
  toolCallId: z.string().min(1).max(120),
});

function buildRejectedToolResult(toolCallId: string, planId: string) {
  return [
    {
      type: "tool_result" as const,
      tool_use_id: toolCallId,
      content: JSON.stringify({
        approved: false,
        planId,
        note: "The merchant rejected this plan. Do NOT execute any of its steps. Acknowledge briefly and ask what they'd like to do instead — or just stop and wait for their next message.",
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

  const plan = await findPlanByToolCallId(store.id, toolCallId);
  if (!plan) return new Response("Not found", { status: 404 });

  const flip = await rejectPlan(store.id, toolCallId);
  if (!flip.ok) {
    return Response.json({ ok: false, error: flip.reason }, { status: 409 });
  }

  const after = await findPlanByToolCallId(store.id, toolCallId);

  const toolResultBlocks = buildRejectedToolResult(toolCallId, plan.id);

  const txOps: Prisma.PrismaPromise<unknown>[] = [];
  if (!flip.alreadyDone) {
    txOps.push(
      prisma.auditLog.create({
        data: {
          storeId: store.id,
          action: "plan_rejected",
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
