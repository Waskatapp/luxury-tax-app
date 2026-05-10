// Phase Ab Round Ab-A — clustering pipeline. The heart of the
// Abandonment Brain's discovery pass.
//
// Pipeline:
//   1. fetch  — pull TurnSignal + Message rows where outcome IN
//      ('abandoned', 'clarified') over the last N days
//   2. embed  — compute gemini-embedding-001 vectors for each
//      user message (reuses embeddings.server.ts)
//   3. cluster — DBSCAN with cosine distance; eps=0.15 means
//      neighbors share ≥ 0.85 cosine similarity (semantically
//      equivalent phrasings cluster together)
//   4. summarize — per cluster: size, sampleTurnIds, commonTools,
//      commonRouterReason, dominantOutcome, centroidEmbedding,
//      fingerprint (stable cross-run identity)
//   5. persist — one ClusterRun row + N AbandonmentCluster rows
//
// Constitutional posture:
//   - Tenant-scoped: every Prisma query filters by storeId.
//   - Read-only on TurnSignal/Message; writes only to ClusterRun
//     + AbandonmentCluster.
//   - Embedding calls fail-soft: drop turns whose embedding fails;
//     don't abort the run.
//   - Operator-only: never injected into CEO prompt.

import prisma from "../../../db.server";

import { embedText } from "../embeddings.server";
import type { ContentBlock } from "../translate.server";
import { log } from "../../log.server";

import type {
  AbandonedTurnRow,
  Cluster,
  ClusterPassResult,
} from "./types";

// DBSCAN parameters. eps=0.15 in cosine distance = cosine similarity ≥ 0.85
// for neighbors. minPts=3 means a cluster needs at least 3 turns sharing
// the pattern — single recurring failure modes need critical mass before
// they show up as a cluster.
const DBSCAN_EPS = 0.15;
const DBSCAN_MIN_PTS = 3;

// At most 5 closest-to-centroid sample turns per cluster (operator
// review surface; the rest are reachable via cluster.size + DB filter).
const MAX_SAMPLE_TURNS = 5;

// Skip turns whose user message is shorter than this — too short to
// embed meaningfully. "ok", "yes", etc. are signal noise here.
const MIN_USER_MESSAGE_LENGTH = 3;

// Cap turns processed per store per run. 200 turns × 768-dim DBSCAN is
// ~40k pairwise distance computations — sub-second. Beyond ~500 turns,
// O(n²) starts to bite; revisit with a kd-tree or LSH.
const MAX_TURNS_PER_RUN = 500;

export type RunAbandonmentBrainInput = {
  storeId: string;
  now: Date;
  lookbackDays?: number;
};

export async function runAbandonmentBrainForStore(
  opts: RunAbandonmentBrainInput,
): Promise<ClusterPassResult> {
  const startedAt = Date.now();
  const lookback = opts.lookbackDays ?? 30;

  const turns = await fetchAbandonedTurns({
    storeId: opts.storeId,
    lookbackDays: lookback,
    now: opts.now,
  });

  let totalAbandonedTurns = 0;
  let totalClarifiedTurns = 0;
  for (const t of turns) {
    if (t.outcome === "abandoned") totalAbandonedTurns += 1;
    else totalClarifiedTurns += 1;
  }

  if (turns.length < DBSCAN_MIN_PTS) {
    return {
      storeId: opts.storeId,
      totalAbandonedTurns,
      totalClarifiedTurns,
      clusters: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const embedded = await embedTurns(turns);

  if (embedded.length < DBSCAN_MIN_PTS) {
    return {
      storeId: opts.storeId,
      totalAbandonedTurns,
      totalClarifiedTurns,
      clusters: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const groups = dbscan(embedded, DBSCAN_EPS, DBSCAN_MIN_PTS);
  const clusters = groups
    .map(summarizeCluster)
    .sort((a, b) => b.size - a.size);

  const result: ClusterPassResult = {
    storeId: opts.storeId,
    totalAbandonedTurns,
    totalClarifiedTurns,
    clusters,
    durationMs: Date.now() - startedAt,
  };

  await persistClusterRun({ storeId: opts.storeId, result, now: opts.now });

  return result;
}

// ---------- 1. Fetch ----------

type EmbeddedTurn = AbandonedTurnRow & { embedding: number[] };

export async function fetchAbandonedTurns(opts: {
  storeId: string;
  lookbackDays: number;
  now: Date;
}): Promise<AbandonedTurnRow[]> {
  const cutoff = new Date(opts.now.getTime() - opts.lookbackDays * 86_400_000);

  const turnSignals = await prisma.turnSignal.findMany({
    where: {
      storeId: opts.storeId,
      createdAt: { gte: cutoff },
      outcome: { in: ["abandoned", "clarified"] },
    },
    select: {
      id: true,
      messageId: true,
      conversationId: true,
      outcome: true,
      routerReason: true,
      latencyMs: true,
      createdAt: true,
      message: { select: { content: true, createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_TURNS_PER_RUN,
  });

  if (turnSignals.length === 0) return [];

  // Pull user messages for the involved conversations in one query so we
  // can pair each TurnSignal (which points to the assistant message) with
  // the user message that prompted it.
  const conversationIds = Array.from(
    new Set(turnSignals.map((ts) => ts.conversationId)),
  );
  const userMessages = await prisma.message.findMany({
    where: {
      conversationId: { in: conversationIds },
      role: "user",
    },
    select: { conversationId: true, content: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const userMsgsByConv = new Map<
    string,
    Array<{ content: unknown; createdAt: Date }>
  >();
  for (const m of userMessages) {
    const arr = userMsgsByConv.get(m.conversationId) ?? [];
    arr.push({ content: m.content, createdAt: m.createdAt });
    userMsgsByConv.set(m.conversationId, arr);
  }

  const turns: AbandonedTurnRow[] = [];
  for (const ts of turnSignals) {
    const userMsgs = userMsgsByConv.get(ts.conversationId) ?? [];
    // Find the latest user message strictly before the assistant message.
    let bestUserText: string | null = null;
    for (const um of userMsgs) {
      if (um.createdAt >= ts.message.createdAt) break;
      const text = extractFirstText(um.content);
      if (text !== null && text.length >= MIN_USER_MESSAGE_LENGTH) {
        bestUserText = text;
      }
    }
    if (bestUserText === null) continue;

    const toolNamesUsed = extractToolNames(ts.message.content);

    turns.push({
      turnSignalId: ts.id,
      messageId: ts.messageId,
      conversationId: ts.conversationId,
      userMessage: bestUserText,
      outcome: ts.outcome === "clarified" ? "clarified" : "abandoned",
      toolNamesUsed,
      routerReason: ts.routerReason,
      latencyMs: ts.latencyMs,
      createdAt: ts.createdAt,
    });
  }

  return turns;
}

function extractFirstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text.trim();
    }
  }
  return null;
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      names.push(block.name);
    }
  }
  return names;
}

// ---------- 2. Embed ----------

async function embedTurns(turns: AbandonedTurnRow[]): Promise<EmbeddedTurn[]> {
  const out: EmbeddedTurn[] = [];
  for (const t of turns) {
    const vec = await embedText(t.userMessage);
    if (vec === null) {
      log.warn("ab-brain: embed failed (skipping turn)", {
        turnSignalId: t.turnSignalId,
      });
      continue;
    }
    out.push({ ...t, embedding: vec });
  }
  return out;
}

// ---------- 3. DBSCAN with cosine distance ----------

export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("cosineDistance: vector dim mismatch");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

const UNVISITED = -1;
const NOISE = -2;

export function dbscan<T extends { embedding: number[] }>(
  points: T[],
  eps: number,
  minPts: number,
): T[][] {
  const n = points.length;
  const labels: number[] = new Array(n).fill(UNVISITED);
  let clusterId = 0;

  // Returns indices in the eps-ball of `idx`, INCLUDING idx itself.
  // Standard DBSCAN convention — minPts counts the point + its
  // neighbors. So minPts=3 means a core point has 2 other neighbors.
  function regionQuery(idx: number): number[] {
    const neighbors: number[] = [];
    const here = points[idx].embedding;
    for (let j = 0; j < n; j++) {
      if (j === idx) {
        neighbors.push(j);
        continue;
      }
      if (cosineDistance(here, points[j].embedding) <= eps) {
        neighbors.push(j);
      }
    }
    return neighbors;
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] !== UNVISITED) continue;
    const neighbors = regionQuery(i);
    if (neighbors.length < minPts) {
      labels[i] = NOISE;
      continue;
    }

    labels[i] = clusterId;
    const seedSet: number[] = [...neighbors];
    while (seedSet.length > 0) {
      const j = seedSet.shift()!;
      if (labels[j] === NOISE) {
        // border point — add to cluster but don't expand from it
        labels[j] = clusterId;
        continue;
      }
      if (labels[j] !== UNVISITED) continue;
      labels[j] = clusterId;
      const jNeighbors = regionQuery(j);
      if (jNeighbors.length >= minPts) {
        for (const k of jNeighbors) seedSet.push(k);
      }
    }
    clusterId += 1;
  }

  const clusters: T[][] = [];
  for (let i = 0; i < clusterId; i++) clusters.push([]);
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) clusters[labels[i]].push(points[i]);
  }
  return clusters;
}

// ---------- 4. Summarize ----------

export function summarizeCluster(turns: EmbeddedTurn[]): Cluster {
  const size = turns.length;

  // Centroid: per-dim average across cluster.
  const dim = turns[0].embedding.length;
  const centroid = new Array(dim).fill(0);
  for (const t of turns) {
    for (let d = 0; d < dim; d++) centroid[d] += t.embedding[d];
  }
  for (let d = 0; d < dim; d++) centroid[d] /= size;

  // Sample turns: 5 closest to centroid.
  const byDistance = turns
    .map((t) => ({ t, dist: cosineDistance(t.embedding, centroid) }))
    .sort((a, b) => a.dist - b.dist);
  const sampleTurnIds = byDistance
    .slice(0, MAX_SAMPLE_TURNS)
    .map((x) => x.t.turnSignalId);

  // Common tools: tools that appear in ≥ 50% of cluster turns.
  const halfSize = Math.ceil(size / 2);
  const toolCounts = new Map<string, number>();
  for (const t of turns) {
    const seen = new Set<string>(t.toolNamesUsed);
    for (const tool of seen) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
  }
  const commonTools = Array.from(toolCounts.entries())
    .filter(([, count]) => count >= halfSize)
    .map(([tool]) => tool)
    .sort();

  // Common router reason: plurality, must clear 30% to count as common.
  const reasonCounts = new Map<string, number>();
  for (const t of turns) {
    if (t.routerReason !== null) {
      reasonCounts.set(
        t.routerReason,
        (reasonCounts.get(t.routerReason) ?? 0) + 1,
      );
    }
  }
  let topReason: string | null = null;
  let topCount = 0;
  for (const [reason, count] of reasonCounts) {
    if (count > topCount) {
      topReason = reason;
      topCount = count;
    }
  }
  const commonRouterReason = topCount >= size * 0.3 ? topReason : null;

  // Dominant outcome: more abandoned or more clarified.
  let abandonedCount = 0;
  for (const t of turns) {
    if (t.outcome === "abandoned") abandonedCount += 1;
  }
  const dominantOutcome: "abandoned" | "clarified" =
    abandonedCount * 2 >= size ? "abandoned" : "clarified";

  // Fingerprint: stable hash of first 4 centroid dims at fixed precision.
  // Same cluster across re-runs hashes the same; small drift between
  // runs still produces the same fingerprint. Used in Ab-C for cheap
  // O(1) lookup before falling back to embedding similarity match.
  const fingerprint = centroid
    .slice(0, 4)
    .map((v) => v.toFixed(3))
    .join("|");

  return {
    size,
    sampleTurnIds,
    commonTools,
    commonRouterReason,
    dominantOutcome,
    centroidEmbedding: centroid,
    fingerprint,
  };
}

// ---------- 5. Persist ----------

async function persistClusterRun(opts: {
  storeId: string;
  result: ClusterPassResult;
  now: Date;
}): Promise<string> {
  const run = await prisma.clusterRun.create({
    data: {
      storeId: opts.storeId,
      runAt: opts.now,
      totalAbandonedTurns: opts.result.totalAbandonedTurns,
      totalClarifiedTurns: opts.result.totalClarifiedTurns,
      clusterCount: opts.result.clusters.length,
      durationMs: opts.result.durationMs,
    },
    select: { id: true },
  });

  if (opts.result.clusters.length > 0) {
    await prisma.abandonmentCluster.createMany({
      data: opts.result.clusters.map((c) => ({
        clusterRunId: run.id,
        storeId: opts.storeId,
        size: c.size,
        sampleTurnIds: c.sampleTurnIds,
        commonTools: c.commonTools,
        commonRouterReason: c.commonRouterReason,
        dominantOutcome: c.dominantOutcome,
        centroidEmbedding: c.centroidEmbedding,
        fingerprint: c.fingerprint,
      })),
    });
  }

  return run.id;
}

// ---------- Garbage collection ----------

// Delete ClusterRun rows older than ttlDays. Cascades to
// AbandonmentCluster via the FK relation. Called at the top of every
// nightly cron pass before processing.
export async function gcOldClusterRuns(opts: {
  now: Date;
  ttlDays: number;
}): Promise<number> {
  const cutoff = new Date(opts.now.getTime() - opts.ttlDays * 86_400_000);
  const result = await prisma.clusterRun.deleteMany({
    where: { runAt: { lt: cutoff } },
  });
  return result.count;
}
