-- V3.1 — Phase 3 Autonomous Reasoning Loop. Adds ActionFollowup (the CEO's
-- "I'll check this later" queue) and Insight (the offline evaluator's output,
-- surfaced into next conversation's CEO Observations slot).
--
-- ActionFollowup.evaluationCriteria is JSONB written by the CEO per action
-- (`min_sessions`, `min_days`, `max_days`) — never hardcoded thresholds. The
-- offline evaluator (.github/workflows/followup-evaluator.yml, ships in 3.2)
-- queries WHERE status='PENDING' AND dueAt<=NOW(); the [storeId, status, dueAt]
-- index serves that hot path.
--
-- Insight.followupId is unique → logical 1:1 with ActionFollowup. Modeled as
-- plain string columns on both sides (no Prisma relation field) to avoid
-- circular relation declarations. Insight.surfacedAt drives the daily rate
-- limit (≤2 unique surfaces per (storeId, day)) — see Phase 3.3.
--
-- Both `status` and `verdict`/`category` are TEXT not enums so we can extend
-- the taxonomy without further migrations (mirrors Plan, TurnSignal, Artifact).

CREATE TABLE "ActionFollowup" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "conversationId" TEXT,
    "auditLogId" TEXT,
    "toolCallId" TEXT,
    "productId" TEXT,
    "metric" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "expectedDirection" TEXT NOT NULL,
    "expectedEffectPct" DOUBLE PRECISION,
    "baselineSnapshot" JSONB NOT NULL,
    "evaluationCriteria" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "abandonAt" TIMESTAMP(3) NOT NULL,
    "evaluatedAt" TIMESTAMP(3),
    "insightId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionFollowup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActionFollowup_storeId_idx" ON "ActionFollowup"("storeId");

CREATE INDEX "ActionFollowup_storeId_status_dueAt_idx" ON "ActionFollowup"("storeId", "status", "dueAt");

CREATE INDEX "ActionFollowup_conversationId_idx" ON "ActionFollowup"("conversationId");

ALTER TABLE "ActionFollowup" ADD CONSTRAINT "ActionFollowup_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActionFollowup" ADD CONSTRAINT "ActionFollowup_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "followupId" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "significanceP" DOUBLE PRECISION,
    "surfacedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Insight_followupId_key" ON "Insight"("followupId");

CREATE INDEX "Insight_storeId_surfacedAt_idx" ON "Insight"("storeId", "surfacedAt");

CREATE INDEX "Insight_storeId_createdAt_idx" ON "Insight"("storeId", "createdAt");

ALTER TABLE "Insight" ADD CONSTRAINT "Insight_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
