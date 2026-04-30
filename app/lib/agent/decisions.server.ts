import type { Decision } from "@prisma/client";

import prisma from "../../db.server";
import { log } from "../log.server";

// V4.1 — Phase 4 Decision Memory & Retrieval. The decision journal — one row
// per outcome-bearing commitment the CEO makes. Created alongside an
// ActionFollowup (every followup has a Decision twin) so the CEO can recall
// past decisions semantically when facing a similar situation.
//
// Embeddings are stored as `Float[]` (Postgres double-precision array). We
// don't use pgvector — Railway's stock Postgres image doesn't include the
// extension and `CREATE EXTENSION vector` would fail at deploy. At ≤1000
// decisions per store, fetching all embeddings (one storeId-scoped query,
// indexed) and computing cosine in Node is ~60ms — within budget. If scale
// demands it later, swap to pgvector with a single migration.
//
// The `embeddingPending` flag lets the post-stream embedding tick query for
// unembedded rows without a full-table scan.

export type DecisionCategory =
  | "conversion_rate"
  | "revenue"
  | "sessions"
  | "units_sold"
  | "aov"
  | "inventory_at_risk"
  | "strategic";

export type DecisionRow = {
  id: string;
  storeId: string;
  auditLogId: string | null;
  planId: string | null;
  followupId: string | null;
  conversationId: string | null;
  productId: string | null;
  category: DecisionCategory;
  hypothesis: string;
  expectedOutcome: string;
  actualOutcome: string | null;
  lesson: string | null;
  embedding: number[];
  embeddingPending: boolean;
  createdAt: string;
  updatedAt: string;
};

function toRow(d: Decision): DecisionRow {
  return {
    id: d.id,
    storeId: d.storeId,
    auditLogId: d.auditLogId,
    planId: d.planId,
    followupId: d.followupId,
    conversationId: d.conversationId,
    productId: d.productId,
    category: d.category as DecisionCategory,
    hypothesis: d.hypothesis,
    expectedOutcome: d.expectedOutcome,
    actualOutcome: d.actualOutcome,
    lesson: d.lesson,
    embedding: d.embedding ?? [],
    embeddingPending: d.embeddingPending,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// Synthesize the `expectedOutcome` text from a followup's structured
// fields. The Decision lives longer than the followup and is read back
// during retrieval, so the prose form is what the LLM will consume.
export function synthesizeExpectedOutcome(opts: {
  expectedDirection: "lift" | "drop" | "neutral";
  expectedEffectPct: number | null | undefined;
  metric: string;
}): string {
  const { expectedDirection, expectedEffectPct, metric } = opts;
  if (expectedDirection === "neutral") {
    return `Expect no significant change in ${metric}.`;
  }
  const direction = expectedDirection === "lift" ? "lift" : "drop";
  if (expectedEffectPct !== null && expectedEffectPct !== undefined) {
    return `Expect a ${Math.abs(expectedEffectPct)}% ${direction} in ${metric}.`;
  }
  return `Expect a ${direction} in ${metric}.`;
}

export type CreateDecisionInput = {
  storeId: string;
  followupId?: string | null;
  planId?: string | null;
  auditLogId?: string | null;
  conversationId?: string | null;
  productId?: string | null;
  category: DecisionCategory;
  hypothesis: string;
  expectedOutcome: string;
};

export async function createDecision(
  input: CreateDecisionInput,
): Promise<DecisionRow> {
  const row = await prisma.decision.create({
    data: {
      storeId: input.storeId,
      followupId: input.followupId ?? null,
      planId: input.planId ?? null,
      auditLogId: input.auditLogId ?? null,
      conversationId: input.conversationId ?? null,
      productId: input.productId ?? null,
      category: input.category,
      hypothesis: input.hypothesis,
      expectedOutcome: input.expectedOutcome,
      embedding: [], // populated by the lazy embedding tick
      embeddingPending: true,
    },
  });
  return toRow(row);
}

// Best-effort wrapper: never throws. Mirrors safeCreatePlan / safeCreateFollowup.
export async function safeCreateDecision(
  input: CreateDecisionInput,
): Promise<DecisionRow | null> {
  try {
    return await createDecision(input);
  } catch (err) {
    log.error("safeCreateDecision failed", {
      err,
      storeId: input.storeId,
      followupId: input.followupId,
    });
    return null;
  }
}

// Used by the offline evaluator (3.2) when an ActionFollowup matures.
// Fills in the actualOutcome on the linked Decision so retrieval surfaces
// "we tried X, here's what happened" rather than just "we tried X."
export async function recordOutcomeOnDecision(opts: {
  followupId: string;
  actualOutcome: string;
}): Promise<void> {
  await prisma.decision.updateMany({
    where: { followupId: opts.followupId },
    data: { actualOutcome: opts.actualOutcome },
  });
}

export async function findDecisionById(
  storeId: string,
  id: string,
): Promise<DecisionRow | null> {
  const row = await prisma.decision.findFirst({ where: { id, storeId } });
  return row ? toRow(row) : null;
}

// Used by the lazy embedding tick in api.chat.tsx — fetch a few decisions
// that haven't been embedded yet. Cap small to keep p99 latency stable.
export async function listDecisionsNeedingEmbedding(
  storeId: string,
  limit = 2,
): Promise<DecisionRow[]> {
  const rows = await prisma.decision.findMany({
    where: { storeId, embeddingPending: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(toRow);
}

export async function setDecisionEmbedding(opts: {
  id: string;
  embedding: number[];
}): Promise<void> {
  await prisma.decision.update({
    where: { id: opts.id },
    data: {
      embedding: opts.embedding,
      embeddingPending: false,
    },
  });
}

export async function listAllDecisions(
  storeId: string,
  limit = 200,
): Promise<DecisionRow[]> {
  const rows = await prisma.decision.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRow);
}

// Cosine similarity between two equal-dimensional vectors. Returns a
// number in [-1, 1]; 1 means identical direction, 0 orthogonal, -1
// opposite. Pure function — exported for unit testing.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export type SimilarDecision = DecisionRow & { similarity: number };

// Find the top N decisions most semantically similar to `queryEmbedding`.
// Pulls every embedded decision for this store (storeId-indexed query),
// computes cosine in Node, sorts, returns top N above the threshold.
//
// Phase 4.3 calls this with `minSimilarity: 0.85` and `topN: 3`. Lower
// thresholds yield false positives; the LLM gets confused when surface-
// dissimilar decisions are shown as "similar precedent."
export async function findSimilarDecisions(opts: {
  storeId: string;
  queryEmbedding: number[];
  topN?: number;
  minSimilarity?: number;
}): Promise<SimilarDecision[]> {
  const topN = opts.topN ?? 3;
  // V6.7 — bumped from 0.85 to 0.90 after switching the embedding model
  // from text-embedding-004 to gemini-embedding-001. The new model's
  // similarity geometry runs hotter — generic queries like "hello" were
  // matching domain-specific decisions at 0.85+, surfacing irrelevant
  // past-decision blocks the CEO then fabricated narratives around.
  // 0.90 is the new safer floor; tune downward only after measuring real
  // similarity scores in production.
  const minSim = opts.minSimilarity ?? 0.9;

  if (opts.queryEmbedding.length === 0) return [];

  // Only consider decisions that have been embedded. Pulling all of them
  // is fine at our scale — the cosine pass is ~10ms even at 1000 rows.
  const candidates = await prisma.decision.findMany({
    where: { storeId: opts.storeId, embeddingPending: false },
    orderBy: { createdAt: "desc" },
    // No take limit — we want to consider all decisions; the top-N gate
    // is applied AFTER cosine. Capped implicitly by total decisions per
    // store (≤1000 per project lifetime is realistic).
  });

  if (candidates.length === 0) return [];

  const scored: SimilarDecision[] = [];
  for (const c of candidates) {
    const embedding = c.embedding ?? [];
    if (embedding.length === 0) continue;
    const sim = cosineSimilarity(opts.queryEmbedding, embedding);
    if (sim >= minSim) {
      scored.push({ ...toRow(c), similarity: sim });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topN);
}

// Compact prose representation of a Decision for the prompt's "Past
// decisions on similar situations" section. Token-cheap — 2-4 lines per
// decision. Phase 4.3 caps total injected at 1200 tokens; this format
// gives ~80-150 tokens per decision.
export function formatDecisionForPrompt(d: SimilarDecision): string {
  const ageDays = Math.floor(
    (Date.now() - new Date(d.createdAt).getTime()) / (24 * 3600 * 1000),
  );
  const ageStr =
    ageDays === 0 ? "today" : ageDays === 1 ? "1 day ago" : `${ageDays} days ago`;
  const outcome = d.actualOutcome ?? "outcome pending evaluation";
  const lesson = d.lesson ? `\n  Lesson: ${d.lesson}` : "";
  return `- (${ageStr}, similarity ${(d.similarity * 100).toFixed(0)}%) ${d.category}: ${d.hypothesis}\n  Outcome: ${outcome}${lesson}`;
}

export function formatDecisionsAsMarkdown(
  decisions: SimilarDecision[],
  totalCandidates: number,
): string {
  if (decisions.length === 0) return "";
  const intro =
    totalCandidates > decisions.length
      ? `These are the ${decisions.length} most relevant past decisions out of ${totalCandidates} similar ones in the journal. Reference them naturally if they're load-bearing for the merchant's current ask — don't list them mechanically. Skip them entirely if they don't actually apply.`
      : `These are past decisions semantically similar to what the merchant is asking about. Reference them naturally if they're load-bearing — don't list them mechanically. Skip if they don't apply.`;
  return [intro, "", ...decisions.map(formatDecisionForPrompt)].join("\n");
}
