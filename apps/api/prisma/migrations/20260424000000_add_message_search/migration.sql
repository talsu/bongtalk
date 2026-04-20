-- Task-015-B: full-text search over Message content.
--
-- Two indexes serve two languages with one query:
--   - tsvector(simple) + GIN → English (and any language tokenized
--     by whitespace / ASCII punctuation).
--   - pg_trgm GIN on content → Korean / CJK substring matching (the
--     `simple` tokenizer doesn't split non-space-separated text).
--
-- The generated `search_tsv` column is STORED so SELECT never has to
-- recompute to_tsvector — write amplification is single-digit% on
-- insert, which is acceptable for beta volume.
--
-- Both indexes are partial `WHERE "deletedAt" IS NULL` so soft-
-- deleted messages don't bloat the GIN pages; the search path also
-- filters `AND "deletedAt" IS NULL` so the planner can pick them up.
--
-- CONCURRENTLY: Prisma runs migrations in an implicit transaction
-- and CREATE INDEX CONCURRENTLY can't run inside one. For dev /
-- test / fresh migrate-deploy the plain CREATE INDEX here is fine
-- (empty or tiny table). Production rollout runs
--   docker exec qufox-postgres-prod psql -v ON_ERROR_STOP=1 \
--     -U qufox -d qufox \
--     -f scripts/deploy/sql/task-015-message-search-concurrent.sql
-- BEFORE the API rollout to avoid AccessExclusive on Message. Plan
-- to add that hook script in the next deploy pass.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "Message"
  ADD COLUMN "search_tsv" tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED;

CREATE INDEX "Message_search_tsv_idx"
  ON "Message" USING GIN ("search_tsv")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "Message_content_trgm_idx"
  ON "Message" USING GIN ("content" gin_trgm_ops)
  WHERE "deletedAt" IS NULL;
