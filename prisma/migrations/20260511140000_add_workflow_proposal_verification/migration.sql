-- Phase Ab Round Ab-C-prime — verification loop columns on WorkflowProposal.
--
-- Nullable + default 0 so existing rows backfill cleanly. New status
-- strings (FIX_SHIPPED, VERIFIED_FIXED, FIX_DIDNT_HELP,
-- FIX_DIDNT_HELP_GIVING_UP) are added via application logic — status is
-- already a TEXT column, no enum to alter.

ALTER TABLE "WorkflowProposal"
  ADD COLUMN "shippedAt"            TIMESTAMP(3),
  ADD COLUMN "baselineClusterSize"  INTEGER,
  ADD COLUMN "verifiedAt"           TIMESTAMP(3),
  ADD COLUMN "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastVerifyError"      TEXT;
