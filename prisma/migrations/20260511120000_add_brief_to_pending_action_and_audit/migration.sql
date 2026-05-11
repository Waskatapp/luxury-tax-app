-- Phase Mn Round Mn-1 — `brief` field on tool calls.
-- Nullable so existing rows backfill cleanly; new rows get the CEO's
-- one-line intent string when it emits one. Operators read this in
-- /app/settings/audit to understand WHY a write happened, not just WHAT.

ALTER TABLE "PendingAction" ADD COLUMN "brief" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "brief" TEXT;
