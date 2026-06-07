-- S85 (FR-CH-16) — 사이드바 개인 섹션.
--
-- ADDITIVE + reversible. enum 1개 + 테이블 2개를 더한다(기존 row 영향 없음 — backfill 불요):
--
--   SidebarSectionSortMode        — MANUAL / ALPHABETICAL.
--   UserSidebarSection            — (userId, workspaceId, position) 인덱스. 개인 섹션 원장.
--                                   user/workspace onDelete Cascade.
--   UserSidebarChannelAssignment  — (userId, channelId) unique(채널은 사용자당 1섹션),
--                                   (userId, sectionId, position) 인덱스. user/channel/section
--                                   onDelete Cascade(섹션 삭제 시 할당 정리 → 채널 기본 위치 복귀).
--
-- 전 DDL 을 멱등으로 감싼다(s43 IF NOT EXISTS 패턴 일관): enum 은 DO $$ … pg_type 검사,
-- 테이블은 CREATE TABLE IF NOT EXISTS, 인덱스는 CREATE [UNIQUE] INDEX IF NOT EXISTS,
-- FK 는 제약 존재검사(DO $$ … IF NOT EXISTS (pg_constraint) … ADD CONSTRAINT …).
-- NO CONCURRENTLY(트랜잭션 마이그레이션 정합). down.sql 이 테이블·enum 을 역순 DROP 한다.
-- PG16 throwaway DB 로 up→down→up 검증.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SidebarSectionSortMode') THEN
    CREATE TYPE "SidebarSectionSortMode" AS ENUM ('MANUAL', 'ALPHABETICAL');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "UserSidebarSection" (
  "id"          UUID NOT NULL,
  "userId"      UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "name"        VARCHAR(100) NOT NULL,
  "emoji"       VARCHAR(16),
  "sortMode"    "SidebarSectionSortMode" NOT NULL DEFAULT 'MANUAL',
  "position"    DECIMAL(20,10) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserSidebarSection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UserSidebarSection_userId_workspaceId_position_idx"
  ON "UserSidebarSection" ("userId", "workspaceId", "position");

CREATE TABLE IF NOT EXISTS "UserSidebarChannelAssignment" (
  "id"        UUID NOT NULL,
  "userId"    UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "sectionId" UUID NOT NULL,
  "position"  DECIMAL(20,10) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserSidebarChannelAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserSidebarChannelAssignment_userId_channelId_key"
  ON "UserSidebarChannelAssignment" ("userId", "channelId");

CREATE INDEX IF NOT EXISTS "UserSidebarChannelAssignment_userId_sectionId_position_idx"
  ON "UserSidebarChannelAssignment" ("userId", "sectionId", "position");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserSidebarSection_userId_fkey'
  ) THEN
    ALTER TABLE "UserSidebarSection"
      ADD CONSTRAINT "UserSidebarSection_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserSidebarSection_workspaceId_fkey'
  ) THEN
    ALTER TABLE "UserSidebarSection"
      ADD CONSTRAINT "UserSidebarSection_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserSidebarChannelAssignment_userId_fkey'
  ) THEN
    ALTER TABLE "UserSidebarChannelAssignment"
      ADD CONSTRAINT "UserSidebarChannelAssignment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserSidebarChannelAssignment_channelId_fkey'
  ) THEN
    ALTER TABLE "UserSidebarChannelAssignment"
      ADD CONSTRAINT "UserSidebarChannelAssignment_channelId_fkey"
      FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserSidebarChannelAssignment_sectionId_fkey'
  ) THEN
    ALTER TABLE "UserSidebarChannelAssignment"
      ADD CONSTRAINT "UserSidebarChannelAssignment_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "UserSidebarSection"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
