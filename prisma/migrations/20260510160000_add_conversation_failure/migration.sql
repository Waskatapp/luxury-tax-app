-- Phase Wf Round Wf-C — in-conversation failure scratchpad.
--
-- New table only; no schema changes to existing tables. Indexed on
-- (conversationId, createdAt desc) so the augmenter's "most recent N
-- distinct codes" query is a single bounded scan.

CREATE TABLE "ConversationFailure" (
  "id"             TEXT NOT NULL,
  "storeId"        TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "toolName"       TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "errorMessage"   TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationFailure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationFailure_conversationId_createdAt_idx"
  ON "ConversationFailure" ("conversationId", "createdAt" DESC);

CREATE INDEX "ConversationFailure_storeId_idx"
  ON "ConversationFailure" ("storeId");

ALTER TABLE "ConversationFailure"
  ADD CONSTRAINT "ConversationFailure_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationFailure"
  ADD CONSTRAINT "ConversationFailure_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
