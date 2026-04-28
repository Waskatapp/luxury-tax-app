import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  DescriptionArtifactContentSchema,
  discardArtifact,
  findArtifactById,
  updateArtifactContent,
} from "../lib/agent/artifacts.server";

// V2.5 — Artifact CRUD endpoint.
//
//   GET    /api/artifact?id=<artifactId>          — read
//   PATCH  /api/artifact { id, content }          — update DRAFT body
//   DELETE /api/artifact { id }                   — discard (DRAFT → DISCARDED)
//
// All tenant-scoped via requireStoreAccess. The "approve" path lives in
// api.artifact-approve.tsx because it has additional Shopify-write +
// AuditLog responsibilities.

const PatchBodySchema = z.object({
  id: z.string().min(1).max(120),
  // For now content is always the description shape. Extend to a discriminated
  // union when more kinds land.
  content: DescriptionArtifactContentSchema,
});

const DeleteBodySchema = z.object({
  id: z.string().min(1).max(120),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });
  const artifact = await findArtifactById(store.id, id);
  if (!artifact) return new Response("Not found", { status: 404 });
  return Response.json({ artifact });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  if (request.method === "PATCH") {
    const parsed = PatchBodySchema.safeParse(await request.json());
    if (!parsed.success) return new Response("Invalid body", { status: 400 });
    const outcome = await updateArtifactContent(
      store.id,
      parsed.data.id,
      parsed.data.content,
    );
    if (!outcome.ok) {
      return Response.json({ ok: false, error: outcome.reason }, { status: 409 });
    }
    return Response.json({ ok: true, artifact: outcome.artifact });
  }

  if (request.method === "DELETE") {
    const parsed = DeleteBodySchema.safeParse(await request.json());
    if (!parsed.success) return new Response("Invalid body", { status: 400 });
    // Look up the artifact BEFORE flipping so we have the toolCallId for
    // the synthesized tool_result (Gemini needs it to close out the
    // propose_artifact call cleanly on the next turn).
    const existing = await findArtifactById(store.id, parsed.data.id);
    if (!existing) return new Response("Not found", { status: 404 });

    const outcome = await discardArtifact(store.id, parsed.data.id);
    if (!outcome.ok) {
      return Response.json({ ok: false, error: outcome.reason }, { status: 409 });
    }

    // If the merchant clicks Discard twice, only synthesize the
    // tool_result + bump conversation on the first click. A duplicate
    // tool_result would create two user-turn messages with the same
    // tool_use_id and Gemini would get confused.
    if (outcome.alreadyDone) {
      return Response.json({
        ok: true,
        artifact: outcome.artifact,
        alreadyDone: true,
        conversationId: existing.conversationId,
      });
    }

    const toolResultBlocks = [
      {
        type: "tool_result" as const,
        tool_use_id: existing.toolCallId,
        content: JSON.stringify({
          approved: false,
          discarded: true,
          note: "The merchant discarded this draft without applying it. Acknowledge briefly and ask what they'd like to do instead — don't re-quote the discarded content.",
        }),
      },
    ];

    const txOps: Prisma.PrismaPromise<unknown>[] = [];
    txOps.push(
      prisma.message.create({
        data: {
          conversationId: existing.conversationId,
          role: "user",
          content: toolResultBlocks as unknown as object,
        },
      }),
    );
    txOps.push(
      prisma.conversation.update({
        where: { id: existing.conversationId },
        data: { updatedAt: new Date() },
      }),
    );
    await prisma.$transaction(txOps);

    return Response.json({
      ok: true,
      artifact: outcome.artifact,
      alreadyDone: false,
      conversationId: existing.conversationId,
    });
  }

  return new Response("Method not allowed", { status: 405 });
};
