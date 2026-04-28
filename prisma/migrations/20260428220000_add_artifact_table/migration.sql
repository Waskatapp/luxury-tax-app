-- V2.5 — Artifact table. The CEO's editable buffer for prose drafts that the
-- merchant edits in the side panel before approval. Created when the CEO
-- calls `propose_artifact`; on approval the latest content is funneled
-- through the regular write tool's PendingAction flow so AuditLog and the
-- "every Shopify write requires approval" rule still hold.
--
-- `toolCallId` is unique → ties the Artifact row to the assistant Message's
-- `tool_use` block by id. Same dedupe pattern as PendingAction / Plan.
-- `status` is TEXT (not an enum) so we can extend the lifecycle without
-- another migration. `content` shape varies by `kind` (validated in
-- artifacts.server.ts via Zod).

CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "toolCallId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Artifact_toolCallId_key" ON "Artifact"("toolCallId");

CREATE INDEX "Artifact_conversationId_idx" ON "Artifact"("conversationId");

CREATE INDEX "Artifact_storeId_status_idx" ON "Artifact"("storeId", "status");

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
