-- S63 (D12 / FR-RM05·06·07) — 모더레이션(Kick / Ban / Timeout).
--
-- 두 가지 비파괴(additive) 변경:
--   1. WorkspaceMember.mutedUntil 컬럼 추가(FR-RM07 타임아웃 만료 시각, lazy 체크).
--   2. BannedMember 테이블 신규(FR-RM06 영구 차단 목록, userId 기반).
-- 신규 컬럼/테이블만 추가하므로 reversible 하다 — down.sql 이 컬럼·테이블·인덱스·FK 를
-- 역순으로 DROP 한다.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s51/s53/s54/s55/s60/s61/s62 패턴과 일관한다.
-- ★ TIMESTAMPTZ(6) 정밀도는 기존 컨벤션(AuditLog/UserChannelMute)을 따른다.
-- ★ PG16 throwaway DB 로 up→down→up 검증.

-- 1. WorkspaceMember.mutedUntil (FR-RM07).
ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "mutedUntil" TIMESTAMPTZ(6);

-- 2. BannedMember 테이블 (FR-RM06).
CREATE TABLE IF NOT EXISTS "BannedMember" (
  "workspaceId" UUID           NOT NULL,
  "userId"      UUID           NOT NULL,
  "bannedBy"    UUID           NOT NULL,
  "reason"      VARCHAR(512),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BannedMember_pkey" PRIMARY KEY ("workspaceId", "userId")
);

CREATE INDEX IF NOT EXISTS "BannedMember_workspaceId_createdAt_idx"
  ON "BannedMember" ("workspaceId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BannedMember_workspaceId_fkey'
  ) THEN
    ALTER TABLE "BannedMember"
      ADD CONSTRAINT "BannedMember_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
