// Pure helpers for the batched approve/reject flow. Extracted from
// api.tool-approve.tsx / api.tool-reject.tsx so the per-row processing logic
// can be unit-tested without Prisma. The route files compose these helpers
// with prisma calls.

import type { ContentBlock } from "./translate.server";

export type PendingRow = {
  id: string;
  toolCallId: string;
  conversationId: string;
  toolName: string;
  toolInput: Record<string, unknown> | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
};

export type RowResult = {
  toolCallId: string;
  status: "EXECUTED" | "FAILED" | "APPROVED" | "REJECTED" | "PENDING";
  error?: string;
};

export type ProcessedApproveRow = {
  pendingId: string;
  toolCallId: string;
  toolName: string;
  finalStatus: "EXECUTED" | "FAILED" | "APPROVED" | "REJECTED";
  before: unknown;
  after: unknown;
  error: string | null;
  skip: boolean;
};

export type ProcessedRejectRow = {
  pendingId: string;
  toolCallId: string;
  toolName: string;
  finalStatus: "REJECTED" | "EXECUTED" | "FAILED" | "APPROVED";
  skip: boolean;
};

// All toolCallIds must belong to the same conversation. Returns a string
// describing the first violation, or null if everything looks fine.
export function validateBatch(
  rows: PendingRow[],
): { ok: true; conversationId: string } | { ok: false; reason: string } {
  if (rows.length === 0) return { ok: false, reason: "no rows" };
  const conversationIds = new Set(rows.map((r) => r.conversationId));
  if (conversationIds.size !== 1) {
    return {
      ok: false,
      reason: "All toolCallIds must belong to the same conversation",
    };
  }
  return { ok: true, conversationId: rows[0].conversationId };
}

// Build the consolidated synthetic user-turn tool_result blocks for an
// approve batch. One block per processed row; skipped rows record their
// existing status; failed rows mark is_error: true.
export function buildApproveToolResults(
  processed: ProcessedApproveRow[],
): ContentBlock[] {
  return processed.map((p) => ({
    type: "tool_result",
    tool_use_id: p.toolCallId,
    content: JSON.stringify(
      p.skip
        ? { status: p.finalStatus.toLowerCase() }
        : p.error
          ? { error: p.error }
          : (p.after ?? { ok: true }),
    ),
    is_error: !p.skip && p.error !== null,
  }));
}

// Same shape for the reject path. All non-skipped rows are { rejected: true }.
export function buildRejectToolResults(
  processed: ProcessedRejectRow[],
): ContentBlock[] {
  return processed.map((p) => ({
    type: "tool_result",
    tool_use_id: p.toolCallId,
    content: JSON.stringify(
      p.skip
        ? { status: p.finalStatus.toLowerCase() }
        : {
            rejected: true,
            reason: "merchant rejected the action; no change was made",
          },
    ),
    is_error: false,
  }));
}

// Sequential approve orchestration. Receives the pending rows, the requested
// order, and three callbacks: flip (atomic PENDING → APPROVED), snapshot
// (best-effort before-snapshot), execute (the Shopify mutation). Returns the
// per-row processed list (for transaction op building) AND the response
// payload list (what the client sees). All async; never parallelizes.
export async function processApproveBatch(params: {
  toolCallIds: string[];
  rowByCallId: Map<string, PendingRow>;
  flipPending: (toolCallId: string) => Promise<{ count: number }>;
  snapshot: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Promise<unknown>;
  execute: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
}): Promise<{
  processed: ProcessedApproveRow[];
  responseResults: RowResult[];
}> {
  const { toolCallIds, rowByCallId, flipPending, snapshot, execute } = params;
  const processed: ProcessedApproveRow[] = [];
  const responseResults: RowResult[] = [];

  for (const id of toolCallIds) {
    const existing = rowByCallId.get(id);
    if (!existing) {
      responseResults.push({
        toolCallId: id,
        status: "FAILED",
        error: "not found",
      });
      continue;
    }

    const flipped = await flipPending(id);
    if (flipped.count === 0) {
      responseResults.push({
        toolCallId: id,
        status: existing.status,
        error: `already ${existing.status.toLowerCase()}`,
      });
      processed.push({
        pendingId: existing.id,
        toolCallId: id,
        toolName: existing.toolName,
        finalStatus: existing.status as ProcessedApproveRow["finalStatus"],
        before: null,
        after: null,
        error: null,
        skip: true,
      });
      continue;
    }

    const toolInput = (existing.toolInput ?? {}) as Record<string, unknown>;
    const before = await snapshot(existing.toolName, toolInput);
    const result = await execute(existing.toolName, toolInput);

    const finalStatus = result.ok ? "EXECUTED" : "FAILED";
    const after = result.ok ? (result.data ?? null) : null;
    const error = result.ok ? null : result.error;

    processed.push({
      pendingId: existing.id,
      toolCallId: id,
      toolName: existing.toolName,
      finalStatus,
      before,
      after,
      error,
      skip: false,
    });
    responseResults.push({
      toolCallId: id,
      status: finalStatus,
      ...(error ? { error } : {}),
    });
  }

  return { processed, responseResults };
}

// Sequential reject orchestration. Just flips PENDING → REJECTED per row;
// no Shopify call.
export async function processRejectBatch(params: {
  toolCallIds: string[];
  rowByCallId: Map<string, PendingRow>;
  flipPending: (toolCallId: string) => Promise<{ count: number }>;
}): Promise<{
  processed: ProcessedRejectRow[];
  responseResults: RowResult[];
}> {
  const { toolCallIds, rowByCallId, flipPending } = params;
  const processed: ProcessedRejectRow[] = [];
  const responseResults: RowResult[] = [];

  for (const id of toolCallIds) {
    const existing = rowByCallId.get(id);
    if (!existing) {
      responseResults.push({
        toolCallId: id,
        status: "FAILED",
        error: "not found",
      });
      continue;
    }

    const flipped = await flipPending(id);
    if (flipped.count === 0) {
      responseResults.push({
        toolCallId: id,
        status: existing.status,
        error: `already ${existing.status.toLowerCase()}`,
      });
      processed.push({
        pendingId: existing.id,
        toolCallId: id,
        toolName: existing.toolName,
        finalStatus: existing.status as ProcessedRejectRow["finalStatus"],
        skip: true,
      });
      continue;
    }

    processed.push({
      pendingId: existing.id,
      toolCallId: id,
      toolName: existing.toolName,
      finalStatus: "REJECTED",
      skip: false,
    });
    responseResults.push({ toolCallId: id, status: "REJECTED" });
  }

  return { processed, responseResults };
}

// Batch-level summary — what the response payload's `ok` flag should be,
// and the first surfacing-worthy error message (if any) for the client banner.
export function summarizeBatchOutcome(
  responseResults: RowResult[],
): { ok: boolean; firstError: string | null } {
  const allExecuted = responseResults.every((r) => r.status === "EXECUTED");
  const firstError = responseResults.find((r) => r.error)?.error ?? null;
  return { ok: allExecuted, firstError };
}
