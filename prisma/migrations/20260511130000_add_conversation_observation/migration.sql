-- Phase Mn Round Mn-3 — in-conversation positive observation scratchpad.
--
-- Counterpart to ConversationFailure: stores what the agent has *learned*
-- mid-conversation so a later turn doesn't re-read the same data. New
-- table only. Same index shape as ConversationFailure for the augmenter's
-- "most recent N distinct kinds" query.

CREATE TABLE "ConversationObservation" (
  "id"             TEXT NOT NULL,
  "storeId"        TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "summary"        TEXT NOT NULL,
  "sourceToolName" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationObservation_conversationId_createdAt_idx"
  ON "ConversationObservation" ("conversationId", "createdAt" DESC);

CREATE INDEX "ConversationObservation_storeId_idx"
  ON "ConversationObservation" ("storeId");

ALTER TABLE "ConversationObservation"
  ADD CONSTRAINT "ConversationObservation_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationObservation"
  ADD CONSTRAINT "ConversationObservation_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
