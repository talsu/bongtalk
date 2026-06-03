-- S53 (D10 / FR-PS-09/10/11) — 개인 저장함 리마인더(저장 리마인더).
--
-- ADDITIVE + reversible. SavedMessage 에 4개 nullable 컬럼 + 1개 partial index 를
-- 더한다(기존 row 안전 — 전부 NULL 백필, backfill 불요):
--
--   1. reminderAt       TIMESTAMPTZ NULL — 예약 발화 시각(UTC). null = 리마인더 미설정.
--   2. reminderFiredAt  TIMESTAMPTZ NULL — 실제 발화 시각. 중복 발화 방지 + 놓친
--                       리마인더(overdue) 판정. null = 아직 미발화.
--   3. snoozedUntil     TIMESTAMPTZ NULL — 스누즈("10분 후 다시") 재예약 시각.
--   4. note             VARCHAR(500) NULL — 사용자 메모.
--
-- ★ partial index — BullMQ worker 가 재기동/복구 시 "발화 대기 중인" 행만
-- 좁게 스캔하도록 reminderAt 이 설정됐고 아직 미발화인 행만 인덱싱한다. CONCURRENTLY
-- 는 사용하지 않는다 — `prisma migrate deploy` 는 각 migration.sql 을 단일 트랜잭션으로
-- 실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 내 금지)와 비호환이다. 일반
-- CREATE INDEX 는 짧은 쓰기 잠금이 있으나 신규 컬럼이라 인덱싱 대상 행이 0건이므로
-- 사실상 즉시 완료된다.
--
-- ⚠️ Prisma @@index 는 partial WHERE 절을 표현하지 못하므로 이 인덱스는 raw SQL 로만
-- 정의하고 schema.prisma 에는 주석으로만 남긴다(introspection drift 회피 — schema 의
-- @@index 로 동일 이름의 full index 를 선언하면 안 된다).
--
-- 전 DDL 을 멱등으로 감싼다(s51 IF NOT EXISTS 패턴 일관). down.sql 이 역순(인덱스 →
-- 컬럼)으로 되돌린다. PG16 throwaway DB 로 up→down→up 검증.

ALTER TABLE "SavedMessage"
  ADD COLUMN IF NOT EXISTS "reminderAt"      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reminderFiredAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "snoozedUntil"    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "note"            VARCHAR(500);

CREATE INDEX IF NOT EXISTS "SavedMessage_reminderAt_idx"
  ON "SavedMessage" ("reminderAt")
  WHERE "reminderAt" IS NOT NULL AND "reminderFiredAt" IS NULL;
