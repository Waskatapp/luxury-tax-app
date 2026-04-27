-- Add searchText column for V1.7 conversation search.
-- AlterTable
ALTER TABLE "Message" ADD COLUMN "searchText" TEXT;

-- Backfill: extract concatenated text from each row's `content` JSONB
-- (keeping only blocks where type='text'), lowercase, store on searchText.
-- Rows whose content has no text blocks (tool_use-only / tool_result-only)
-- end up with empty string from string_agg → flip to NULL so the search
-- query can skip them cleanly.
UPDATE "Message"
SET "searchText" = NULLIF(
  LOWER(
    COALESCE(
      (
        SELECT string_agg(block->>'text', ' ')
        FROM jsonb_array_elements("content") AS block
        WHERE block->>'type' = 'text'
          AND block->>'text' IS NOT NULL
      ),
      ''
    )
  ),
  ''
)
WHERE jsonb_typeof("content") = 'array';
