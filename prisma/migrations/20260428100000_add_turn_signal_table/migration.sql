-- V2.2 — TurnSignal table. One row per completed assistant turn. Captures
-- the outcome (approved / rejected / clarified / rephrased / abandoned /
-- informational) plus latency and metadata. Phase 2.6 (Reflection) mines
-- this for prompt-block tweaks.
--
-- `outcome` is text not an enum so the taxonomy can grow without another
-- migration. `messageId` is unique → 1:1 with the assistant Message row.

CREATE TABLE "TurnSignal" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "hadWriteTool" BOOLEAN NOT NULL DEFAULT false,
    "hadClarification" BOOLEAN NOT NULL DEFAULT false,
    "hadPlan" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "modelUsed" TEXT,
    "ceoConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnSignal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TurnSignal_messageId_key" ON "TurnSignal"("messageId");

CREATE INDEX "TurnSignal_storeId_createdAt_idx" ON "TurnSignal"("storeId", "createdAt");

CREATE INDEX "TurnSignal_storeId_outcome_idx" ON "TurnSignal"("storeId", "outcome");

CREATE INDEX "TurnSignal_conversationId_idx" ON "TurnSignal"("conversationId");

ALTER TABLE "TurnSignal" ADD CONSTRAINT "TurnSignal_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TurnSignal" ADD CONSTRAINT "TurnSignal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TurnSignal" ADD CONSTRAINT "TurnSignal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
