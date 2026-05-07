-- task-044-iter2: pinned messages. Reversible — DROP 컬럼 + 인덱스
-- 으로 되돌립니다.

ALTER TABLE "Message"
  ADD COLUMN "pinnedAt" TIMESTAMPTZ,
  ADD COLUMN "pinnedBy" UUID;

-- 채널별 pinned 조회 인덱스. partial WHERE pinnedAt IS NOT NULL 로
-- 미고정 row 는 인덱스에서 제외해 sparse 유지.
CREATE INDEX "Message_channelId_pinnedAt_idx"
  ON "Message" ("channelId", "pinnedAt" DESC)
  WHERE "pinnedAt" IS NOT NULL;
