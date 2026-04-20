-- User request 2026-04-21: capture a per-category description at
-- creation time (UI surfaces it in the create modal; surfacing on
-- the sidebar comes later). Matches the existing Channel.topic
-- shape — nullable text, no length enforcement at the DB layer
-- because the Zod validator caps at 1024 chars.

ALTER TABLE "Category"
  ADD COLUMN "description" TEXT;
