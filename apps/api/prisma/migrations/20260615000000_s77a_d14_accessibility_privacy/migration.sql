-- S77a (D14 / FR-PS-12·13) — 접근성 + 프라이버시 설정.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다:
--
--   1. FriendReqPolicy enum 신규(EVERYONE/MUTUAL_WORKSPACE/NOBODY).
--   2. UserSettings 에 nullable 없는 default 컬럼 5개를 ADD:
--      reduceMotion(BOOLEAN NOT NULL DEFAULT false)                  — FR-PS-12 접근성(모션 줄이기).
--      highContrast(BOOLEAN NOT NULL DEFAULT false)                  — FR-PS-12 접근성(고대비).
--      allowDmFromWorkspaceMembers(BOOLEAN NOT NULL DEFAULT true)    — FR-PS-13 워크스페이스 멤버발 DM 허용.
--      messageRequestEnabled(BOOLEAN NOT NULL DEFAULT true)          — FR-PS-13 메시지 요청 수신 허용(저장만·carryover).
--      allowFriendRequests(FriendReqPolicy NOT NULL DEFAULT 'EVERYONE') — FR-PS-13 친구 요청 정책.
--      기존 UserSettings 행은 default 로 backfill 되어 무회귀(미설정 = 기본 동작 = 접근성 OFF·
--      DM/메시지요청 허용·친구요청 EVERYONE — 즉 종전과 동일하게 모두 허용).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로 실행하므로
--   트랜잭션 블록에서 금지되는 CONCURRENTLY 를 쓰지 않는다(순수 additive 라 인덱스 추가도 없음).
-- ★ 완전 가역: 신규 enum 1개 + additive 컬럼 5개라 down.sql 은 컬럼 DROP 후 enum TYPE DROP 으로
--   무손실 역행한다(s76 의 "신규 enum = 완전 가역" 선례). 다운그레이드 손실은 접근성/프라이버시
--   값에 한정되며 전역 신원·기존 DM 권한(User.allowDmFrom)·친구관계·메시징은 무영향.
-- ★ 멱등 가드(CREATE TYPE 은 DO $$ · ADD COLUMN 은 IF NOT EXISTS)로 기존 패턴과 일관.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. FriendReqPolicy enum 신규 ────────────────────────────────────────────
-- CREATE TYPE 은 IF NOT EXISTS 를 지원하지 않으므로 DO $$ 가드로 멱등화한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FriendReqPolicy') THEN
    CREATE TYPE "FriendReqPolicy" AS ENUM ('EVERYONE', 'MUTUAL_WORKSPACE', 'NOBODY');
  END IF;
END
$$;

-- ── 2. UserSettings additive 컬럼 5개 ───────────────────────────────────────
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "reduceMotion"                BOOLEAN           NOT NULL DEFAULT false;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "highContrast"                BOOLEAN           NOT NULL DEFAULT false;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "allowDmFromWorkspaceMembers" BOOLEAN           NOT NULL DEFAULT true;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "messageRequestEnabled"       BOOLEAN           NOT NULL DEFAULT true;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "allowFriendRequests"         "FriendReqPolicy" NOT NULL DEFAULT 'EVERYONE';
