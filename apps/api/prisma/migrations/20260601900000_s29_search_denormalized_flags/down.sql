-- S29 down — 비정규화 검색 플래그 제거(reversible).
-- 플래그는 attachments / 본문에서 재계산 가능한 파생값이므로 손실 무해하다.
DROP INDEX IF EXISTS "Message_channelId_hasFile_idx";
DROP INDEX IF EXISTS "Message_channelId_hasImage_idx";
DROP INDEX IF EXISTS "Message_channelId_hasLink_idx";

ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "hasFile",
  DROP COLUMN IF EXISTS "hasImage",
  DROP COLUMN IF EXISTS "hasLink";
