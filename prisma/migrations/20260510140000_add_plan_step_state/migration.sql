-- Phase Re Round Re-C1 — Plan per-step state machine.
--
-- New columns on Plan: currentStepIndex (0-indexed; advances on tool
-- dispatch), lastStepFailureCode, lastStepFailureAt.
--
-- The `steps` JSON shape evolves from
--   { description, departmentId, estimatedTool? }
-- to
--   { description, departmentId, estimatedTool?, status, completedAt?, failureCode? }
-- where status defaults to 'pending'. Existing rows get backfilled in
-- a single UPDATE so the read path doesn't need a defensive default-
-- on-read code path.
--
-- All three column adds are non-destructive (defaults / nullable).

ALTER TABLE "Plan" ADD COLUMN "currentStepIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "lastStepFailureCode" TEXT;
ALTER TABLE "Plan" ADD COLUMN "lastStepFailureAt" TIMESTAMP(3);

-- Backfill existing plans: every step gets status='pending'. Plans that
-- have already been executed (or rejected) stay at currentStepIndex=0
-- since we can't reconstruct exact step states from history without
-- expensive cross-table joins. The Re-C2 resume detection adds a
-- recency TTL anyway — old plans won't auto-resume regardless.
UPDATE "Plan"
SET steps = (
  SELECT jsonb_agg(
    jsonb_set(s, '{status}', '"pending"'::jsonb, true)
  )
  FROM jsonb_array_elements("Plan".steps::jsonb) AS s
)::json
WHERE "Plan".steps IS NOT NULL
  AND jsonb_typeof("Plan".steps::jsonb) = 'array'
  AND jsonb_array_length("Plan".steps::jsonb) > 0
  -- Only backfill rows where the first step does NOT already have
  -- a status field (idempotent; safe to re-run).
  AND NOT ("Plan".steps::jsonb -> 0 ? 'status');
