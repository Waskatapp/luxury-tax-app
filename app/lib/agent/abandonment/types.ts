// Phase Ab — Abandonment Brain pure types. No DB, no SDK.
//
// The brain is a self-running diagnosis loop:
//   1. LEARN  — cluster abandoned/clarified turns by user-message similarity
//   2. SMART  — (Ab-B) LLM hypothesizes root cause per cluster
//   3. REMEMBER — (Ab-C) match new clusters to existing diagnoses; track lifecycle
//   4. ADAPT  — (Ab-D) high-confidence diagnoses cross-file as SystemHealthFinding
//
// Round Ab-A persists ClusterRun + AbandonmentCluster only. Diagnosis,
// hypothesis, and lifecycle land in Ab-B/C/D.

// What we read out of TurnSignal+Message for clustering. Slim by design —
// the cluster pass shouldn't drag full message blobs across the wire.
export type AbandonedTurnRow = {
  turnSignalId: string;
  messageId: string;
  conversationId: string;
  userMessage: string; // already trimmed; embedded
  outcome: "abandoned" | "clarified";
  toolNamesUsed: string[];
  routerReason: string | null;
  latencyMs: number | null;
  createdAt: Date;
};

// What clusterAbandonedTurns returns for one cluster. Persistence layer
// converts to AbandonmentCluster rows (adds clusterRunId).
export type Cluster = {
  size: number;
  sampleTurnIds: string[]; // turnSignalIds, up to 5 closest-to-centroid
  commonTools: string[]; // tools that appear in ≥ 50% of cluster turns
  commonRouterReason: string | null; // most-frequent router reason; null if no plurality
  dominantOutcome: "abandoned" | "clarified"; // most-frequent outcome
  centroidEmbedding: number[]; // average embedding across cluster turns
  fingerprint: string; // stable hash for cross-run identity
};

export type ClusterPassResult = {
  storeId: string;
  totalAbandonedTurns: number;
  totalClarifiedTurns: number;
  clusters: Cluster[];
  durationMs: number;
};
