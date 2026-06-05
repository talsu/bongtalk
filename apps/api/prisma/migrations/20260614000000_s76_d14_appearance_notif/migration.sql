-- S76 (D14 / FR-PS-09·10) — 외관 설정 + 알림 채널 토글.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다:
--
--   1. Theme enum 신규(DARK/LIGHT/SYSTEM) + Density enum 신규(COZY/COMPACT).
--   2. UserSettings 에 nullable 없는 default 컬럼 6개를 ADD:
--      theme(Theme NOT NULL DEFAULT 'DARK')      — FR-PS-09 테마.
--      density(Density NOT NULL DEFAULT 'COZY')  — FR-PS-09 메시지 밀도.
--      chatFontSize(INTEGER NOT NULL DEFAULT 15) — FR-PS-09 채팅 폰트 크기(6단계 중 15px).
--      clock24h(BOOLEAN NOT NULL DEFAULT false)  — FR-PS-09 24시간 시계.
--      notifDesktop(BOOLEAN NOT NULL DEFAULT true) — FR-PS-10 데스크톱 배너 ON/OFF.
--      notifMobile(BOOLEAN NOT NULL DEFAULT true)  — FR-PS-10 모바일 푸시 ON/OFF.
--      기존 UserSettings 행은 default 로 backfill 되어 무회귀(미설정 = 종전 외관 = DARK/COZY/15).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 트랜잭션 블록에서 금지되는 ADD COLUMN ... CONCURRENTLY / CREATE INDEX
--   CONCURRENTLY 를 쓰지 않는다(순수 additive 라 인덱스 추가도 없음).
-- ★ 완전 가역: 신규 enum 2개 + additive 컬럼 6개라 down.sql 은 컬럼 DROP 후 enum TYPE
--   DROP 으로 무손실 역행한다(s65/s70 의 "신규 enum = 완전 가역" 선례). 다운그레이드
--   손실은 외관/알림채널 값에 한정되며 전역 신원·알림 수준(notifTrigger)·메시징은 무영향.
-- ★ 멱등 가드(CREATE TYPE 은 DO $$ · ADD COLUMN 은 IF NOT EXISTS)로 기존 패턴과 일관.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. Theme / Density enum 신규 ────────────────────────────────────────────
-- CREATE TYPE 은 IF NOT EXISTS 를 지원하지 않으므로 DO $$ 가드로 멱등화한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Theme') THEN
    CREATE TYPE "Theme" AS ENUM ('DARK', 'LIGHT', 'SYSTEM');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Density') THEN
    CREATE TYPE "Density" AS ENUM ('COZY', 'COMPACT');
  END IF;
END
$$;

-- ── 2. UserSettings additive 컬럼 6개 ───────────────────────────────────────
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "theme"        "Theme"   NOT NULL DEFAULT 'DARK';
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "density"      "Density" NOT NULL DEFAULT 'COZY';
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "chatFontSize" INTEGER   NOT NULL DEFAULT 15;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "clock24h"     BOOLEAN   NOT NULL DEFAULT false;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "notifDesktop" BOOLEAN   NOT NULL DEFAULT true;
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "notifMobile"  BOOLEAN   NOT NULL DEFAULT true;
