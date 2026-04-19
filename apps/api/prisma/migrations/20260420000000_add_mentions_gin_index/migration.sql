-- Task-011-B: GIN index on Message.mentions so GET /me/mentions can
-- scan by jsonb containment (`mentions @> '{"users": [<userId>]}'`)
-- without a seq scan. Partial on `deletedAt IS NULL` because mention
-- history for soft-deleted messages is explicitly out of scope.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_mentions_gin_idx"
  ON "Message" USING GIN ("mentions")
  WHERE "deletedAt" IS NULL;
