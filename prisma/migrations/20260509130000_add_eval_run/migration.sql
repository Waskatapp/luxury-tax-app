-- Phase 8 — Eval harness run summary. ONE row per nightly invocation
-- of the eval harness cron. `summary` carries the full
-- EvalScenarioResult[] JSON so the operator UI can render a
-- per-scenario breakdown without joining to a separate table.
--
-- NOT tenant-scoped — the harness runs curated fixtures with
-- fakeAdmin, not against any specific store's data.

CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "totalScenarios" INTEGER NOT NULL,
    "passed" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EvalRun_runAt_idx" ON "EvalRun"("runAt");
