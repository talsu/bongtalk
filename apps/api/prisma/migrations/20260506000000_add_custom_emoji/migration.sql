-- task-037-D: workspace-scoped custom emoji pack. Reversible:
-- DROP TABLE "CustomEmoji" rolls this back cleanly.
CREATE TABLE "CustomEmoji" (
    "id"          UUID        NOT NULL,
    "workspaceId" UUID        NOT NULL,
    "name"        VARCHAR(32) NOT NULL,
    "createdBy"   UUID        NOT NULL,
    "storageKey"  TEXT        NOT NULL,
    "mime"        VARCHAR(127) NOT NULL,
    "sizeBytes"   BIGINT      NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomEmoji_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomEmoji_workspaceId_name_key" ON "CustomEmoji"("workspaceId", "name");
CREATE INDEX "CustomEmoji_workspaceId_idx" ON "CustomEmoji"("workspaceId");

ALTER TABLE "CustomEmoji"
  ADD CONSTRAINT "CustomEmoji_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomEmoji"
  ADD CONSTRAINT "CustomEmoji_createdBy_fkey" FOREIGN KEY ("createdBy")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
