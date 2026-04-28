import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  approveArtifact,
  artifactSummary,
  findArtifactById,
} from "../lib/agent/artifacts.server";
import {
  executeApprovedWrite,
  snapshotBefore,
} from "../lib/agent/executor.server";

// V2.5 — POST /api/artifact-approve. Approves a DRAFT artifact: runs the
// underlying Shopify write with the merchant's edited content (NOT the
// CEO's original draft — the merchant may have edited it in the panel
// before clicking Approve), writes an AuditLog with before/after, flips
// the artifact to APPROVED, and synthesizes a tool_result for the
// propose_artifact tool_use so Gemini knows what happened on continuation.
//
// The audit + execute pattern mirrors api.tool-approve so the "every
// Shopify write through the approval flow" rule (CLAUDE.md §5) still
// holds — the Approve button in the panel IS the approval.

const BodySchema = z.object({
  id: z.string().min(1).max(120),
});

// Build the synthesized tool_result for the propose_artifact tool_use.
// Approval-success path: tells Gemini the artifact was applied so it can
// summarize. Failure path: tells Gemini what went wrong so it can advise
// the merchant rather than claim success.
function buildApprovedToolResult(
  toolCallId: string,
  outcome:
    | { ok: true; productTitle: string; charCount: number }
    | { ok: false; error: string },
) {
  const content = outcome.ok
    ? {
        approved: true,
        applied: true,
        productTitle: outcome.productTitle,
        charCount: outcome.charCount,
        note: "The merchant approved this artifact and the description was applied to Shopify. Acknowledge briefly — don't re-quote the full description back. The diff is already visible in the audit log.",
      }
    : {
        approved: true,
        applied: false,
        error: outcome.error,
        note: "The merchant approved the artifact but applying it to Shopify failed. Tell the merchant what went wrong and offer to retry.",
      };
  return [
    {
      type: "tool_result" as const,
      tool_use_id: toolCallId,
      content: JSON.stringify(content),
      is_error: !outcome.ok,
    },
  ];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { admin, store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { id } = parsed.data;

  // Tenant-scoped lookup. Can't approve another store's artifact.
  const artifact = await findArtifactById(store.id, id);
  if (!artifact) return new Response("Not found", { status: 404 });
  if (artifact.kind !== "description") {
    // Today the only approval flow we know how to run. Future kinds need
    // their own switch arm here.
    return Response.json(
      { ok: false, error: `unsupported kind: ${artifact.kind}` },
      { status: 400 },
    );
  }

  // Snapshot the product's current description BEFORE flipping or writing —
  // matches the AuditLog discipline in api.tool-approve.
  const toolName = "update_product_description";
  const toolInput = {
    productId: artifact.content.productId,
    descriptionHtml: artifact.content.html,
  };
  const before = await snapshotBefore(toolName, toolInput, {
    admin,
    storeId: store.id,
    conversationId: artifact.conversationId,
  });

  // Atomic flip. updateMany returns 0 if the row was already non-DRAFT
  // (concurrent click) — bail without re-executing.
  const flip = await approveArtifact(store.id, id);
  if (!flip.ok) {
    return Response.json({ ok: false, error: flip.reason }, { status: 409 });
  }
  if (flip.alreadyDone) {
    // Already approved on a prior click. Don't re-run Shopify or re-audit;
    // just return the conversationId so the client can continueChat.
    return Response.json({
      ok: true,
      alreadyDone: true,
      conversationId: artifact.conversationId,
    });
  }

  // Run the Shopify write with the LATEST content (read after the flip so
  // any in-flight PATCH that landed before the flip is captured).
  const fresh = await findArtifactById(store.id, id);
  const liveContent = fresh?.content ?? artifact.content;
  const writeInput = {
    productId: liveContent.productId,
    descriptionHtml: liveContent.html,
  };
  const writeResult = await executeApprovedWrite(toolName, writeInput, {
    admin,
    storeId: store.id,
    conversationId: artifact.conversationId,
  });

  const toolResultBlocks = buildApprovedToolResult(
    artifact.toolCallId,
    writeResult.ok
      ? {
          ok: true,
          productTitle: liveContent.productTitle,
          charCount: liveContent.html.length,
        }
      : { ok: false, error: writeResult.error },
  );

  // ONE transaction: AuditLog + synth Message + conversation timestamp.
  const txOps: Prisma.PrismaPromise<unknown>[] = [];
  txOps.push(
    prisma.auditLog.create({
      data: {
        storeId: store.id,
        action: writeResult.ok
          ? "artifact_approved_executed"
          : "artifact_approved_failed",
        toolName,
        before: (before ?? null) as never,
        after: (writeResult.ok
          ? { ...artifactSummary(fresh ?? artifact), html: liveContent.html }
          : { error: writeResult.error }) as never,
      },
    }),
  );
  txOps.push(
    prisma.message.create({
      data: {
        conversationId: artifact.conversationId,
        role: "user",
        content: toolResultBlocks as unknown as object,
      },
    }),
  );
  txOps.push(
    prisma.conversation.update({
      where: { id: artifact.conversationId },
      data: { updatedAt: new Date() },
    }),
  );
  await prisma.$transaction(txOps);

  return Response.json({
    ok: writeResult.ok,
    error: writeResult.ok ? undefined : writeResult.error,
    conversationId: artifact.conversationId,
  });
};
