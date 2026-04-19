-- Task-004: expand Message model with normalized content, mentions json,
-- edit marker, soft-delete, and idempotency key. Adds three indexes for the
-- pagination read path and a PARTIAL unique for idempotent send.

-- 1. Drop the stub pagination index from phase-0 bootstrap.
DROP INDEX "Message_channelId_createdAt_idx";

-- 2. Add new columns. contentPlain is NOT NULL but we must backfill first.
ALTER TABLE "Message"
  ADD COLUMN "contentPlain"   TEXT,
  ADD COLUMN "mentions"       JSONB NOT NULL DEFAULT '{"users":[],"channels":[],"everyone":false}',
  ADD COLUMN "editedAt"       TIMESTAMP(3),
  ADD COLUMN "idempotencyKey" UUID;

-- 3. Backfill normalized content for any pre-existing rows (smoke-test seeds).
UPDATE "Message" SET "contentPlain" = "content" WHERE "contentPlain" IS NULL;

-- 4. Enforce NOT NULL now that backfill is done.
ALTER TABLE "Message" ALTER COLUMN "contentPlain" SET NOT NULL;

-- 5. Pagination primary index: matches ORDER BY createdAt DESC, id DESC with
--    PostgreSQL row-value comparison WHERE ("createdAt","id") < ($1,$2).
CREATE INDEX "Message_channelId_createdAt_id_idx"
  ON "Message"("channelId", "createdAt", "id");

-- 6. Secondary index for soft-delete filter (includeDeleted=false default).
CREATE INDEX "Message_channelId_deletedAt_createdAt_idx"
  ON "Message"("channelId", "deletedAt", "createdAt");

-- 7. Author lookup (future profile page / moderation).
CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");

-- 8. PARTIAL unique index for idempotency: only rows with a key are indexed,
--    so NULL-key sends (no Idempotency-Key header) stay out of the index and
--    incur zero unique-check cost. Conflict → application catches P2002 and
--    returns the existing row with Idempotency-Replayed: true.
CREATE UNIQUE INDEX "Message_authorId_channelId_idempotencyKey_unique"
  ON "Message"("authorId", "channelId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
