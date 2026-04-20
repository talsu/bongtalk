-- Task-016-A (closes task-015-follow-1): rebuild the two FTS indexes
-- with CREATE INDEX CONCURRENTLY so populated-prod deploys don't take
-- an AccessExclusive lock on "Message" for the duration of the build.
--
-- Background: task-015-B's migration created these indexes inside the
-- Prisma migration transaction (plain CREATE INDEX). That was fine for
-- dev/test (empty tables) but would freeze chat on prod. Running this
-- hook AFTER the migration completes means the migration path still
-- uses the non-concurrent form for empty databases, while populated
-- prod reruns this hook's CONCURRENTLY form as a no-op on the same
-- name (the IF NOT EXISTS guards make this safe even if the original
-- migration already created them).
--
-- Idempotent: running twice is a no-op because the IF NOT EXISTS
-- clauses + the CREATE INDEX CONCURRENTLY semantics both short-circuit
-- when the named index already exists.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- auto-deploy.sh invokes this file via `psql -v ON_ERROR_STOP=1`
-- without wrapping it in BEGIN/COMMIT, which is the required mode.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_search_tsv_idx"
  ON "Message" USING GIN ("search_tsv")
  WHERE "deletedAt" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_content_trgm_idx"
  ON "Message" USING GIN ("content" gin_trgm_ops)
  WHERE "deletedAt" IS NULL;
