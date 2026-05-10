-- Phase Ab — Abandonment Brain. Two new tables for the nightly
-- clustering pass that diagnoses why merchants walk away.
--
-- ClusterRun: one row per per-store nightly run (aggregate counts).
-- AbandonmentCluster: one row per cluster of similar abandoned/
-- clarified turns within a run.
--
-- Tenant-scoped. Operator-only — never read by the CEO prompt.

CREATE TABLE "ClusterRun" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "totalAbandonedTurns" INTEGER NOT NULL,
    "totalClarifiedTurns" INTEGER NOT NULL,
    "clusterCount" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClusterRun_storeId_runAt_idx" ON "ClusterRun"("storeId", "runAt");

ALTER TABLE "ClusterRun" ADD CONSTRAINT "ClusterRun_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AbandonmentCluster" (
    "id" TEXT NOT NULL,
    "clusterRunId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sampleTurnIds" TEXT[],
    "commonTools" TEXT[],
    "commonRouterReason" TEXT,
    "dominantOutcome" TEXT NOT NULL,
    "centroidEmbedding" DOUBLE PRECISION[],
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbandonmentCluster_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AbandonmentCluster_storeId_createdAt_idx" ON "AbandonmentCluster"("storeId", "createdAt");
CREATE INDEX "AbandonmentCluster_clusterRunId_idx" ON "AbandonmentCluster"("clusterRunId");
CREATE INDEX "AbandonmentCluster_storeId_fingerprint_idx" ON "AbandonmentCluster"("storeId", "fingerprint");

ALTER TABLE "AbandonmentCluster" ADD CONSTRAINT "AbandonmentCluster_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AbandonmentCluster" ADD CONSTRAINT "AbandonmentCluster_clusterRunId_fkey"
    FOREIGN KEY ("clusterRunId") REFERENCES "ClusterRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
