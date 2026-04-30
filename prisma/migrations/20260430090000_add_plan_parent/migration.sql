-- V5.3 — Phase 5 Strategic Reasoning Layer. Add parentPlanId to Plan so
-- replans can link back to the plan they superseded. When the CEO is
-- mid-execution and finds reality diverged from draft-time assumptions
-- (price already changed, inventory dropped, etc.), it proposes a NEW
-- Plan with parentPlanId set, summarizing the divergence in plan.summary.
--
-- Self-referencing FK with ON DELETE SET NULL: if the parent Plan ever
-- gets purged, the replan stays alive but loses the chain link. (In
-- practice we never delete Plans — they're an audit record. SetNull is
-- defensive, not load-bearing.)
--
-- Purely additive: existing Plan rows get parentPlanId = NULL by default.

ALTER TABLE "Plan" ADD COLUMN "parentPlanId" TEXT;

CREATE INDEX "Plan_parentPlanId_idx" ON "Plan"("parentPlanId");

ALTER TABLE "Plan" ADD CONSTRAINT "Plan_parentPlanId_fkey"
  FOREIGN KEY ("parentPlanId") REFERENCES "Plan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
