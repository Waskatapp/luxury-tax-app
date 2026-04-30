-- V6.8 — Add ianaTimezone to Store. Populated lazily on first chat turn
-- via a Shopify `query { shop { ianaTimezone } }` call, then cached on
-- the Store row indefinitely. Used by ceo-prompt.server.ts to format
-- dates/times in the merchant's local timezone (instead of UTC) so the
-- CEO can correctly resolve "today", "9am", "tomorrow" relative to the
-- merchant — critical for time-sensitive marketing decisions where
-- minute-level precision matters.
--
-- Purely additive. Existing Store rows get NULL; the lazy populator in
-- the chat route fills it on first conversation after deploy.

ALTER TABLE "Store" ADD COLUMN "ianaTimezone" TEXT;
