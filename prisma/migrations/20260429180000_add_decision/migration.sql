-- V4.1 — Decision journal. One row per outcome-bearing commitment the CEO
-- makes. Created alongside an ActionFollowup (every followup has a Decision
-- twin) and later filled in with `actualOutcome` + `lesson` when the offline
-- evaluator marks the followup EVALUATED.
--
-- `embedding` is a Postgres double-precision array (Float[]) of dim 768
-- — Gemini text-embedding-004's native shape. We use plain Postgres
-- arrays rather than pgvector because Railway's stock Postgres doesn't
-- include the extension; at our scale (≤1000 decisions per store)
-- Node-side cosine over a single indexed query is well within budget.
-- Empty array (NOT null) until the post-stream embedding tick fills
-- it; `embeddingPending` lets the tick query for unembedded rows
-- without scanning the whole table.
--
-- `category` is TEXT for extensibility (pricing | description | discount
-- | status | strategic | …). `actualOutcome` and `lesson` are populated
-- post-evaluation and remain null until then.

CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "auditLogId" TEXT,
    "planId" TEXT,
    "followupId" TEXT,
    "conversationId" TEXT,
    "productId" TEXT,
    "category" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "expectedOutcome" TEXT NOT NULL,
    "actualOutcome" TEXT,
    "lesson" TEXT,
    "embedding" DOUBLE PRECISION[],
    "embeddingPending" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Decision_followupId_key" ON "Decision"("followupId");

CREATE INDEX "Decision_storeId_idx" ON "Decision"("storeId");

CREATE INDEX "Decision_storeId_category_createdAt_idx" ON "Decision"("storeId", "category", "createdAt");

CREATE INDEX "Decision_storeId_embeddingPending_idx" ON "Decision"("storeId", "embeddingPending");

ALTER TABLE "Decision" ADD CONSTRAINT "Decision_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
