-- Task-012-B: Attachment table.
--
-- Upload flow is 3-phase:
--   1. POST /attachments/presign-upload → row inserted with
--      finalizedAt=NULL
--   2. client PUTs to MinIO
--   3. POST /attachments/:id/finalize → server HeadObjects MinIO to
--      confirm the byte-size matches what was declared, then stamps
--      finalizedAt and links to the message via messageId.
--
-- Idempotency: `(channelId, clientAttachmentId)` partial unique (WHERE
-- clientAttachmentId IS NOT NULL) — a retried presign-upload call
-- with the same client uuid returns the same row, same key. After
-- finalize + message-send, clientAttachmentId can be reused across
-- workspaces but not within the same channel.
--
-- messageId stays NULL until finalize; the FK is `ON DELETE CASCADE`
-- so deleting a message wipes its attachment rows and the orphan GC
-- (task-012-G) later reaps the MinIO objects.

CREATE TYPE "AttachmentKind" AS ENUM ('IMAGE', 'VIDEO', 'FILE');

CREATE TABLE "Attachment" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "channelId"             UUID NOT NULL REFERENCES "Channel"("id") ON DELETE CASCADE,
  "messageId"             UUID REFERENCES "Message"("id") ON DELETE CASCADE,
  "uploaderId"            UUID NOT NULL REFERENCES "User"("id"),
  "clientAttachmentId"    UUID,
  "kind"                  "AttachmentKind" NOT NULL,
  "mime"                  VARCHAR(127) NOT NULL,
  "sizeBytes"             BIGINT NOT NULL,
  "storageKey"            TEXT NOT NULL,
  "originalName"          TEXT NOT NULL,
  "finalizedAt"           TIMESTAMPTZ,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup for MessageItem rendering (join on messageId).
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId")
  WHERE "messageId" IS NOT NULL;

-- Orphan GC path — rows stuck in unfinalized state past 24h.
CREATE INDEX "Attachment_orphan_idx" ON "Attachment"("uploaderId", "createdAt")
  WHERE "finalizedAt" IS NULL;

-- Idempotency: partial unique over client-supplied uuid, scoped to
-- the channel. NULL clientAttachmentId is allowed freely (server-
-- generated attachments someday).
CREATE UNIQUE INDEX "Attachment_channel_client_uniq"
  ON "Attachment"("channelId", "clientAttachmentId")
  WHERE "clientAttachmentId" IS NOT NULL;
