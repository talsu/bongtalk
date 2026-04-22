-- task-030: Workspace.visibility + Workspace.category for discovery.
-- Reversible: existing rows backfill to PRIVATE (default), so the
-- discovery query (/workspaces/discover) returns 0 until owners flip
-- to PUBLIC via Settings.

CREATE TYPE "WorkspaceVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

CREATE TYPE "WorkspaceCategory" AS ENUM (
  'PROGRAMMING',
  'GAMING',
  'MUSIC',
  'ENTERTAINMENT',
  'SCIENCE',
  'TECH',
  'EDUCATION',
  'OTHER'
);

ALTER TABLE "Workspace"
  ADD COLUMN "visibility" "WorkspaceVisibility" NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN "category"   "WorkspaceCategory";

CREATE INDEX "Workspace_visibility_category_idx"
  ON "Workspace"("visibility", "category");
