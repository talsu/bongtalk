-- task-034-A: widen Channel.workspaceId to nullable so DIRECT rows
-- can be workspace-agnostic. The CHECK constraint preserves the old
-- invariant for every non-DIRECT channel. Pre-migration prod audit
-- showed 0 DIRECT rows in existence, so no backfill is needed — the
-- constraint applies cleanly to existing TEXT / VOICE / ANNOUNCEMENT
-- rows which all have a workspace.

ALTER TABLE "Channel" ALTER COLUMN "workspaceId" DROP NOT NULL;

ALTER TABLE "Channel"
  ADD CONSTRAINT "Channel_workspaceId_type_invariant"
  CHECK (
    (type = 'DIRECT') OR ("workspaceId" IS NOT NULL)
  );
