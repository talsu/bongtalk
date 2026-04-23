-- task-031-D: partial GIN indexes on name + description (trigram) for
-- the /workspaces/discover ILIKE path. Partial predicate filters to
-- PUBLIC + non-deleted + category NOT NULL so the index stays small
-- even as the workspace table grows: the 99 % of rows that never
-- appear in /discover (PRIVATE) are excluded from the index entirely.
--
-- pg_trgm is a standard PG extension. CREATE EXTENSION IF NOT EXISTS
-- keeps the migration idempotent across environments that already
-- have it enabled (e.g. search indexing).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Workspace_discover_name_trgm_idx"
  ON "Workspace" USING GIN (name gin_trgm_ops)
  WHERE "deletedAt" IS NULL AND visibility = 'PUBLIC' AND category IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Workspace_discover_description_trgm_idx"
  ON "Workspace" USING GIN (description gin_trgm_ops)
  WHERE "deletedAt" IS NULL AND visibility = 'PUBLIC' AND category IS NOT NULL
    AND description IS NOT NULL;
