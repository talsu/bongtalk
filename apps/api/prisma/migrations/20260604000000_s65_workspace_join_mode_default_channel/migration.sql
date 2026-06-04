-- S65 (D13 / FR-W01·W19) — 워크스페이스 가입 방식 + 이메일 도메인 화이트리스트 +
-- 기본 채널.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 다음 변경을 한 트랜잭션(prisma
-- migrate deploy)으로 적용한다:
--
--   1. WorkspaceJoinMode enum 신규(PRIVATE/PUBLIC/APPLY).
--   2. Workspace 에 3개 컬럼 추가:
--        - joinMode         WorkspaceJoinMode NOT NULL DEFAULT 'PRIVATE'
--        - emailDomains     TEXT[]            NOT NULL DEFAULT '{}'
--        - defaultChannelId UUID              NULL (FK → Channel, ON DELETE SET NULL)
--   3. Channel 에 1개 컬럼 추가:
--        - isDefault        BOOLEAN           NOT NULL DEFAULT false
--
-- 기존 row 는 전부 안전하게 백필된다(joinMode='PRIVATE'·emailDomains='{}'·
-- defaultChannelId=NULL·isDefault=false). discover(visibility 기반)·joinPublic
-- (visibility 기반) 쿼리는 joinMode 와 무관하므로 무회귀다(직교화).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ enum 가역성: 본 마이그레이션은 WorkspaceJoinMode enum 을 **신규 생성**하고 그
--   enum 을 쓰는 컬럼(Workspace.joinMode)도 함께 추가한다. 따라서 down.sql 은 컬럼을
--   먼저 DROP 한 뒤 enum TYPE 을 DROP 할 수 있다(S61 의 "기존 enum 에 값 추가"
--   비대칭과 달리, 신규 enum 은 완전 가역). PG16 throwaway DB 로 up→down→up 검증.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s51/s53/s54/s55/s60/s61 패턴과 일관한다.

-- ── 1. WorkspaceJoinMode enum 신규 ──────────────────────────────────────────
-- CREATE TYPE 은 IF NOT EXISTS 를 지원하지 않으므로 DO $$ 가드로 멱등화한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkspaceJoinMode') THEN
    CREATE TYPE "WorkspaceJoinMode" AS ENUM ('PRIVATE', 'PUBLIC', 'APPLY');
  END IF;
END
$$;

-- ── 2. Workspace 신규 컬럼 ──────────────────────────────────────────────────
ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "joinMode" "WorkspaceJoinMode" NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN IF NOT EXISTS "emailDomains" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "defaultChannelId" UUID;

-- FR-W19: defaultChannelId → Channel FK. ON DELETE SET NULL 로 기본 채널 hard-delete
-- 시 워크스페이스 행은 유지하고 포인터만 끊는다. ON UPDATE NO ACTION 으로 Channel
-- 의 workspace Cascade 경로와의 다중 캐스케이드 충돌을 피한다. 제약 존재 여부를
-- 가드해 멱등화한다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Workspace_defaultChannelId_fkey'
  ) THEN
    ALTER TABLE "Workspace"
      ADD CONSTRAINT "Workspace_defaultChannelId_fkey"
      FOREIGN KEY ("defaultChannelId") REFERENCES "Channel"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END
$$;

-- defaultChannelId 조회/FK 무결성 검사 가속을 위한 인덱스(SetNull 캐스케이드도 이
-- 인덱스를 쓴다). 대부분 NULL 이라 사실상 부분 인덱스처럼 작고 저렴하다.
CREATE INDEX IF NOT EXISTS "Workspace_defaultChannelId_idx"
  ON "Workspace" ("defaultChannelId");

-- ── 3. Channel.isDefault 신규 컬럼 ──────────────────────────────────────────
ALTER TABLE "Channel"
  ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
