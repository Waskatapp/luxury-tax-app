-- V2.3 — Plan table. One row per `propose_plan` tool call. Used when the
-- CEO needs to walk the merchant through a multi-step or cross-department
-- workflow (audit + cleanup, bulk-action plan, etc.). The merchant approves
-- the plan as a whole; each step's write still goes through the existing
-- ApprovalCard flow.
--
-- `toolCallId` is unique → ties the Plan row to the assistant Message's
-- `tool_use` block by id. Same dedupe pattern as PendingAction. `status` is
-- TEXT (not an enum) so we can extend the lifecycle without another
-- migration.

CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_toolCallId_key" ON "Plan"("toolCallId");

CREATE INDEX "Plan_storeId_idx" ON "Plan"("storeId");

CREATE INDEX "Plan_conversationId_idx" ON "Plan"("conversationId");

CREATE INDEX "Plan_storeId_status_idx" ON "Plan"("storeId", "status");

ALTER TABLE "Plan" ADD CONSTRAINT "Plan_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Plan" ADD CONSTRAINT "Plan_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
