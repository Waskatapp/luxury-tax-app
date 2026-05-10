-- Phase Wf Round Wf-E — Skill Creator. WorkflowProposal table holds the
-- LLM-authored proposals; operator reviews at /app/settings/workflow-proposals
-- and ACCEPTED rows merge into loadWorkflowIndex(storeId) for that store.
-- Per-store unique on `name` so two ACCEPTED workflows can't share a name
-- in the same store. Fingerprint indexed for spam-guard lookups.

CREATE TABLE "WorkflowProposal" (
  "id"          TEXT NOT NULL,
  "storeId"     TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "summary"     TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "triggers"    TEXT[],
  "evidence"    JSONB NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "fingerprint" TEXT NOT NULL,
  "reviewedBy"  TEXT,
  "reviewedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowProposal_storeId_name_key"
  ON "WorkflowProposal" ("storeId", "name");

CREATE INDEX "WorkflowProposal_storeId_status_idx"
  ON "WorkflowProposal" ("storeId", "status");

CREATE INDEX "WorkflowProposal_fingerprint_idx"
  ON "WorkflowProposal" ("fingerprint");

ALTER TABLE "WorkflowProposal"
  ADD CONSTRAINT "WorkflowProposal_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
