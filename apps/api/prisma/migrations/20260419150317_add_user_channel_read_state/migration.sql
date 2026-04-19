-- Task-005: last-read event per user per channel.
-- Drives WS reconnect replay (XRANGE replay:channel:{chid} from lastReadEventId)
-- and, later, the unread-count UI (TODO task-027).

CREATE TABLE "UserChannelReadState" (
  "userId"          UUID NOT NULL,
  "channelId"       UUID NOT NULL,
  "lastReadEventId" UUID NOT NULL,
  "lastReadAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserChannelReadState_pkey" PRIMARY KEY ("userId", "channelId")
);

CREATE INDEX "UserChannelReadState_channelId_idx"
  ON "UserChannelReadState"("channelId");
