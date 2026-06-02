-- S43 (D02 / FR-CH-15) — 사용자별 채널 즐겨찾기.
--
-- ADDITIVE + reversible. 신규 테이블 1개를 더한다(기존 row 영향 없음 — backfill 불요):
--
--   UserChannelFavorite — (userId, channelId) unique, position Decimal(20,10),
--                         user/channel onDelete Cascade. 사이드바 Favorites 섹션
--                         + 즐겨찾기 내 드래그 재정렬(calcBetween fractional)의 원장.
--
-- 전 DDL 을 멱등으로 감싼다(s42 IF NOT EXISTS 패턴 일관): 테이블은 CREATE TABLE
-- IF NOT EXISTS, 인덱스는 CREATE [UNIQUE] INDEX IF NOT EXISTS, FK 는 제약
-- 존재검사(DO $$ … IF NOT EXISTS (pg_constraint) … ADD CONSTRAINT …).
-- down.sql 이 테이블을 DROP 한다(FK·인덱스는 테이블과 함께 사라짐).
-- PG16 throwaway DB 로 up→down→up 검증.

CREATE TABLE IF NOT EXISTS "UserChannelFavorite" (
  "id"        UUID NOT NULL,
  "userId"    UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "position"  DECIMAL(20,10) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserChannelFavorite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserChannelFavorite_userId_channelId_key"
  ON "UserChannelFavorite" ("userId", "channelId");

CREATE INDEX IF NOT EXISTS "UserChannelFavorite_userId_position_idx"
  ON "UserChannelFavorite" ("userId", "position");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserChannelFavorite_userId_fkey'
  ) THEN
    ALTER TABLE "UserChannelFavorite"
      ADD CONSTRAINT "UserChannelFavorite_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserChannelFavorite_channelId_fkey'
  ) THEN
    ALTER TABLE "UserChannelFavorite"
      ADD CONSTRAINT "UserChannelFavorite_channelId_fkey"
      FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
