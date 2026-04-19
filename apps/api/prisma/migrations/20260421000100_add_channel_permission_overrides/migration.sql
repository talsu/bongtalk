-- Task-012-D: per-channel permission overrides.
--
-- `principalType` is 'USER' or 'ROLE'; `principalId` is a User.id UUID
-- or a WorkspaceRole literal ('OWNER'/'ADMIN'/'MEMBER'). Kept as
-- varchar(64) rather than two nullable FKs because (a) ROLE principals
-- aren't rows anywhere, (b) the unique index works cleanly on the
-- composite key.
--
-- Channel.isPrivate was reserved in 005 and is used as-is here.
-- No schema change needed beyond this table.

CREATE TABLE "ChannelPermissionOverride" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "channelId"     UUID NOT NULL REFERENCES "Channel"("id") ON DELETE CASCADE,
  "principalType" VARCHAR(8) NOT NULL,
  "principalId"   VARCHAR(64) NOT NULL,
  "allowMask"     INTEGER NOT NULL DEFAULT 0,
  "denyMask"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "ChannelPermissionOverride_channel_principal_uniq"
  ON "ChannelPermissionOverride"("channelId", "principalType", "principalId");

CREATE INDEX "ChannelPermissionOverride_channelId_idx"
  ON "ChannelPermissionOverride"("channelId");
