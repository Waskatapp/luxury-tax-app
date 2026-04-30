-- V6.6 — Phase 6.6 IT Diagnostic. Adds SystemHealthFinding, the operator-only
-- table the daily cron's diagnostic pass writes to. Read-only on operational
-- tables (Decision, AuditLog, TurnSignal, Conversation, Insight, PendingAction);
-- only this table is written by the new pass.
--
-- Lifecycle: open → acknowledged | snoozed. No verdict/confidence/significanceP
-- (deterministic counters with thresholds, not probabilistic post-mortems). No
-- surfacedAt — these findings are NEVER surfaced into the merchant's chat;
-- they live only at /app/settings/system-health.
--
-- Indexes:
--   (storeId, component, createdAt) — spam-guard hot path. The orchestrator
--     queries "any finding for this (store, component) in the last 7 days,
--     not snoozed-expired" to decide whether to file a new one.
--   (storeId, acknowledgedAt) — settings UI default filter ("hide acknowledged"
--     toggle on by default).
--   (storeId, createdAt) — catch-all chronological listing.
--
-- severity, component, scanName are TEXT (not enums) so we can extend the
-- taxonomy without further migrations (matches Plan, TurnSignal, Insight).

CREATE TABLE "SystemHealthFinding" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "scanName" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemHealthFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SystemHealthFinding_storeId_createdAt_idx" ON "SystemHealthFinding"("storeId", "createdAt");

CREATE INDEX "SystemHealthFinding_storeId_component_createdAt_idx" ON "SystemHealthFinding"("storeId", "component", "createdAt");

CREATE INDEX "SystemHealthFinding_storeId_acknowledgedAt_idx" ON "SystemHealthFinding"("storeId", "acknowledgedAt");

ALTER TABLE "SystemHealthFinding" ADD CONSTRAINT "SystemHealthFinding_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
