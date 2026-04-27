-- V2.0 — add STRATEGIC_GUARDRAILS to MemoryCategory enum, ahead of Phase 2.1
-- (CEO Brain) so guardrails-aware prompt code can ship without piggybacking
-- an enum-only migration onto a feature migration.
--
-- Postgres requires this to run outside a transaction; Prisma migrate
-- handles that automatically for ALTER TYPE ... ADD VALUE statements.
ALTER TYPE "MemoryCategory" ADD VALUE 'STRATEGIC_GUARDRAILS';
