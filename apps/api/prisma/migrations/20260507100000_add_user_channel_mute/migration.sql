-- task-045 iter3: channel/DM mute. mute > event-type pref 우선.
-- Reversible: DROP TABLE 으로 되돌립니다.

CREATE TABLE "UserChannelMute" (
    "id"          UUID         NOT NULL,
    "userId"      UUID         NOT NULL,
    "channelId"   UUID         NOT NULL,
    -- NULL = indefinite mute. 미래 시각이면 그 시점까지만 활성.
    "mutedUntil"  TIMESTAMPTZ,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserChannelMute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserChannelMute_userId_channelId_key"
  ON "UserChannelMute" ("userId", "channelId");

CREATE INDEX "UserChannelMute_channelId_idx"
  ON "UserChannelMute" ("channelId");

ALTER TABLE "UserChannelMute"
  ADD CONSTRAINT "UserChannelMute_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserChannelMute"
  ADD CONSTRAINT "UserChannelMute_channelId_fkey" FOREIGN KEY ("channelId")
    REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
