import type { Artifact } from "@prisma/client";
import { z } from "zod";

import prisma from "../../db.server";
import { log } from "../log.server";

// V2.5 — Artifacts Canvas. Schema, types, and CRUD for the Artifact model.
// One row per `propose_artifact` tool call — the editable buffer between
// the CEO's draft and the actual write tool's PendingAction.
//
// Lifecycle:
//   DRAFT → APPROVED   (merchant clicked Approve in the panel; the latest
//                       content is funneled through update_product_description
//                       via a fresh PendingAction, executed and AuditLogged
//                       there)
//   DRAFT → DISCARDED  (merchant clicked Discard / closed the panel without
//                       approving)
//   DRAFT → REJECTED   (reserved — today the panel only has Approve/Discard
//                       but the lifecycle accommodates a future "reject" UX
//                       distinct from "discard")
//
// Phase 2.5 ships ONE kind: "description". The schema allows future kinds
// (discount-config, promo-copy, plan-as-artifact) without a migration.

export type ArtifactStatus = "DRAFT" | "APPROVED" | "REJECTED" | "DISCARDED";

export const ARTIFACT_KIND_VALUES = ["description"] as const;
export type ArtifactKind = (typeof ARTIFACT_KIND_VALUES)[number];

// Content shape for kind="description". `html` is the editable body — the
// CEO drafts it, the merchant edits it (TextField multiline today, may
// upgrade to a richer editor later). `productId` is the Shopify product
// GID we'll write back to. `productTitle` is purely for the panel header
// so the merchant sees which product they're editing without us re-fetching.
export const DescriptionArtifactContentSchema = z.object({
  productId: z.string().min(1).max(200),
  productTitle: z.string().min(1).max(280),
  html: z.string().max(50_000),
});
export type DescriptionArtifactContent = z.infer<
  typeof DescriptionArtifactContentSchema
>;

export const ProposeArtifactInputSchema = z.object({
  kind: z.enum(ARTIFACT_KIND_VALUES),
  // Wraps content in a discriminated way later if we add more kinds. For
  // now, content must match DescriptionArtifactContent.
  productId: z.string().min(1).max(200),
  productTitle: z.string().min(1).max(280),
  content: z.string().max(50_000),
});
export type ProposeArtifactInput = z.infer<typeof ProposeArtifactInputSchema>;

export type ArtifactRow = {
  id: string;
  storeId: string;
  conversationId: string;
  messageId: string | null;
  toolCallId: string;
  kind: ArtifactKind;
  content: DescriptionArtifactContent;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
};

function toRow(a: Artifact): ArtifactRow {
  return {
    id: a.id,
    storeId: a.storeId,
    conversationId: a.conversationId,
    messageId: a.messageId,
    toolCallId: a.toolCallId,
    kind: a.kind as ArtifactKind,
    content: a.content as unknown as DescriptionArtifactContent,
    status: a.status as ArtifactStatus,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// Idempotent create — re-running propose_artifact with the same toolCallId
// returns the existing row rather than throwing. Mirrors createPlan.
export async function createArtifact(opts: {
  storeId: string;
  conversationId: string;
  toolCallId: string;
  messageId?: string | null;
  kind: ArtifactKind;
  content: DescriptionArtifactContent;
}): Promise<ArtifactRow> {
  const row = await prisma.artifact.upsert({
    where: { toolCallId: opts.toolCallId },
    create: {
      storeId: opts.storeId,
      conversationId: opts.conversationId,
      messageId: opts.messageId ?? null,
      toolCallId: opts.toolCallId,
      kind: opts.kind,
      content: opts.content as unknown as object,
      status: "DRAFT",
    },
    update: {},
  });
  return toRow(row);
}

// Tenant-scoped fetch by id. The PATCH/DELETE/Approve endpoints look up by
// id (the panel knows the id from the SSE event) — toolCallId lookup is
// reserved for chat-side operations.
export async function findArtifactById(
  storeId: string,
  id: string,
): Promise<ArtifactRow | null> {
  const row = await prisma.artifact.findFirst({
    where: { id, storeId },
  });
  return row ? toRow(row) : null;
}

export async function findArtifactByToolCallId(
  storeId: string,
  toolCallId: string,
): Promise<ArtifactRow | null> {
  const row = await prisma.artifact.findFirst({
    where: { toolCallId, storeId },
  });
  return row ? toRow(row) : null;
}

// Sidecar fetch — used by api.messages.tsx so the panel can re-open if the
// merchant reloads the page mid-edit. Only DRAFT rows; once an artifact is
// approved or discarded the panel shouldn't reopen on reload.
export async function listDraftArtifactsForConversation(
  storeId: string,
  conversationId: string,
): Promise<ArtifactRow[]> {
  const rows = await prisma.artifact.findMany({
    where: { storeId, conversationId, status: "DRAFT" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRow);
}

export type ArtifactUpdateOutcome =
  | { ok: true; artifact: ArtifactRow }
  | { ok: false; reason: string };

// Update content in place. Only DRAFT rows are editable — once approved or
// discarded, the content is frozen for audit purposes. Does NOT validate
// the content shape against the kind; callers are expected to pass a
// content matching the existing kind.
export async function updateArtifactContent(
  storeId: string,
  id: string,
  content: DescriptionArtifactContent,
): Promise<ArtifactUpdateOutcome> {
  const result = await prisma.artifact.updateMany({
    where: { id, storeId, status: "DRAFT" },
    data: { content: content as unknown as object },
  });
  if (result.count === 0) {
    // Either not found, wrong store, or non-DRAFT status. Re-read to give a
    // useful reason.
    const row = await prisma.artifact.findFirst({
      where: { id, storeId },
      select: { status: true },
    });
    if (!row) return { ok: false, reason: "artifact not found" };
    return {
      ok: false,
      reason: `artifact is ${row.status}, only DRAFT can be edited`,
    };
  }
  const fresh = await prisma.artifact.findFirst({ where: { id, storeId } });
  return { ok: true, artifact: toRow(fresh!) };
}

export type ArtifactFlipOutcome =
  | { ok: true; artifact: ArtifactRow; alreadyDone: boolean }
  | { ok: false; reason: string };

// Atomic DRAFT → target flip. Same pattern as flipPlanStatus / tool-approve:
// updateMany with WHERE status='DRAFT' so concurrent clicks don't both
// succeed; idempotent if the row is already in the target state.
async function flipArtifactStatus(
  storeId: string,
  id: string,
  target: "APPROVED" | "REJECTED" | "DISCARDED",
): Promise<ArtifactFlipOutcome> {
  const before = await prisma.artifact.findFirst({
    where: { id, storeId },
    select: { status: true },
  });
  if (!before) return { ok: false, reason: "artifact not found" };
  if (before.status === target) {
    const fresh = await prisma.artifact.findFirst({ where: { id, storeId } });
    return { ok: true, artifact: toRow(fresh!), alreadyDone: true };
  }
  if (before.status !== "DRAFT") {
    return {
      ok: false,
      reason: `artifact is ${before.status}, not DRAFT`,
    };
  }
  const result = await prisma.artifact.updateMany({
    where: { id, storeId, status: "DRAFT" },
    data: { status: target },
  });
  if (result.count === 0) {
    const winner = await prisma.artifact.findFirst({
      where: { id, storeId },
      select: { status: true },
    });
    if (winner?.status === target) {
      const fresh = await prisma.artifact.findFirst({
        where: { id, storeId },
      });
      return { ok: true, artifact: toRow(fresh!), alreadyDone: true };
    }
    return {
      ok: false,
      reason: `concurrent flip — artifact is now ${winner?.status ?? "unknown"}`,
    };
  }
  const fresh = await prisma.artifact.findFirst({ where: { id, storeId } });
  return { ok: true, artifact: toRow(fresh!), alreadyDone: false };
}

export function approveArtifact(
  storeId: string,
  id: string,
): Promise<ArtifactFlipOutcome> {
  return flipArtifactStatus(storeId, id, "APPROVED");
}

export function discardArtifact(
  storeId: string,
  id: string,
): Promise<ArtifactFlipOutcome> {
  return flipArtifactStatus(storeId, id, "DISCARDED");
}

// Best-effort create for the executor — never throws. The CEO's
// synthesized tool_result tolerates nulls.
export async function safeCreateArtifact(opts: {
  storeId: string;
  conversationId: string;
  toolCallId: string;
  messageId?: string | null;
  kind: ArtifactKind;
  content: DescriptionArtifactContent;
}): Promise<ArtifactRow | null> {
  try {
    return await createArtifact(opts);
  } catch (err) {
    log.error("safeCreateArtifact failed", {
      err,
      toolCallId: opts.toolCallId,
    });
    return null;
  }
}

// Compact summary for tool_result + audit log. Avoids dumping the full
// content body into Gemini's history (would bloat token cost).
export function artifactSummary(artifact: ArtifactRow): {
  artifactId: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  productTitle: string;
  charCount: number;
  preview: string;
} {
  const html = artifact.content.html;
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    status: artifact.status,
    productTitle: artifact.content.productTitle,
    charCount: html.length,
    preview: html.slice(0, 200) + (html.length > 200 ? "…" : ""),
  };
}

export function isArtifactStatus(value: string): value is ArtifactStatus {
  return (
    value === "DRAFT" ||
    value === "APPROVED" ||
    value === "REJECTED" ||
    value === "DISCARDED"
  );
}
