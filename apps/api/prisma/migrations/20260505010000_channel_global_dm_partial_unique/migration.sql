-- task-034 reviewer HIGH: Channel.@@unique([workspaceId, name]) treats
-- NULL as distinct in postgres, so two concurrent createOrGetWorkspaceless
-- calls for the same pair can both pass findFirst + both INSERT — the
-- P2002 catch never fires on the workspaceless branch.
--
-- Partial unique index on (name) scoped to the global-DM shape closes
-- the race: any second insert with the same dm:<sortedA>:<sortedB> name
-- in the null-workspace DIRECT subset collides and surfaces P2002 as
-- expected.

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_global_dm_name_uniq"
  ON "Channel"(name)
  WHERE "workspaceId" IS NULL
    AND type = 'DIRECT'
    AND "deletedAt" IS NULL;
