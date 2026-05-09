-- Phase 8 — analyzer groups abandoned turns by router reason to surface
-- which heuristics under-serve production traffic.
ALTER TABLE "TurnSignal" ADD COLUMN "routerReason" TEXT;
