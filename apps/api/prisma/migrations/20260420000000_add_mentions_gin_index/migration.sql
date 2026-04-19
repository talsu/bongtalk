-- Task-011-B: GIN index on Message.mentions so GET /me/mentions can
-- scan by jsonb containment (`mentions @> '{"users": [<userId>]}'`)
-- without a seq scan. Partial on `deletedAt IS NULL` because mention
-- history for soft-deleted messages is explicitly out of scope.
--
-- task-011 reviewer HIGH-2 fix: plain CREATE INDEX (NOT CONCURRENTLY).
-- Prisma `migrate deploy` wraps each migration in a transaction and
-- Postgres rejects CONCURRENTLY inside a transaction block. At beta
-- scale the messages table is small enough that a brief exclusive
-- lock is imperceptible; revisit if the table grows past ~100k rows
-- and online index creation becomes necessary (then move this to a
-- separate post-migrate init script outside Prisma's transaction).

CREATE INDEX IF NOT EXISTS "Message_mentions_gin_idx"
  ON "Message" USING GIN ("mentions")
  WHERE "deletedAt" IS NULL;
