-- S80 (D15 / FR-SC-06) — /remind 리마인더 모델.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다. 신규 enum 1개 + 신규 테이블 1개를 추가하며, 기존 테이블/컬럼은 손대지 않는다.
--
--   ReminderStatus{PENDING,SENT,CANCELLED} — /remind 리마인더 상태 머신.
--   Reminder                                — /remind 슬래시 커맨드가 만드는 1급 리마인더.
--
-- ★ Fork1 = Option A(PRD 정본): S53 의 SavedMessage 리마인더(저장 메시지 메타)와 독립한 신규
--   모델이다 — /remind 는 임의 자연어 본문을 시각에 발화하므로 SavedMessage 무결성(원본 메시지
--   FK·@@unique(userId,messageId))을 오염시키지 않는다.
-- ★ BullMQ: scheduledAt 도래 시 발화하는 지연잡을 공유 REMINDER_QUEUE 에 등록한다. 잡 id 는
--   `reminder:{id}` 접두사로 SavedMessage 리마인더(jobId=savedMessageId uuid)와 구분한다.
--   bullJobId 는 등록 잡 id 사본(취소 시 remove 키). null=미등록.
-- ★ targetUserId 는 @person remind(FR-SC-06 확장)용 컬럼만 선반영한다 — 본 슬라이스는 기능 DEFER
--   (항상 발신자 본인에게 발화). FK 도 본 슬라이스에선 걸지 않는다(컬럼만 — 향후 슬라이스가
--   마이그레이션 없이 FK·핸들러만 더하면 되게 둔다).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 트랜잭션 블록에서
--   금지되는 CONCURRENTLY 를 쓰지 않는다(인덱스는 일반 CREATE INDEX).
-- ★ 완전 가역: 신규 enum 1개 + 신규 테이블 1개라 down.sql 은 테이블 DROP → enum DROP 으로 무손실
--   역행한다(s79 "신규 enum + 신규 테이블 = 완전 가역" 선례). 다운그레이드 손실은 예약된 리마인더
--   행에 한정되며, 다른 도메인(메시징·저장함·프로필)은 무영향(이 마이그레이션이 손대지 않음).
-- ★ 멱등 가드(enum 은 DO $$ 의 IF NOT EXISTS, 테이블/인덱스/FK 는 IF NOT EXISTS)로 up→down→up
--   재적용을 안전하게 한다. PG16 throwaway DB 로 up→down→up 검증.

-- ── enum: ReminderStatus ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReminderStatus') THEN
    CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'CANCELLED');
  END IF;
END
$$;

-- ── table: Reminder ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Reminder" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"       UUID NOT NULL,
  "channelId"    UUID,
  "targetUserId" UUID,
  "message"      VARCHAR(500) NOT NULL,
  "scheduledAt"  TIMESTAMPTZ NOT NULL,
  "bullJobId"    TEXT,
  -- S80 reviewer H1: execute 멱등키. 동일 (userId, idempotencyKey) 재시도 시 새 행/잡을
  --   만들지 않게 하는 DB 2차 방어선(Redis slash-idem read-then-write race 보강). REST 직접
  --   생성은 NULL(Postgres 는 NULL 을 distinct 처리하므로 부분 UNIQUE 충돌 없음).
  "idempotencyKey" UUID,
  "status"       "ReminderStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- up→down→up 재적용 시 table IF NOT EXISTS 가 스킵돼도 컬럼은 보강한다(멱등 가드).
ALTER TABLE "Reminder" ADD COLUMN IF NOT EXISTS "idempotencyKey" UUID;

-- 사용자별 상태/시각 목록 + bootstrap 복구 스캔(PENDING·scheduledAt 정렬) 보조 인덱스.
CREATE INDEX IF NOT EXISTS "Reminder_userId_status_scheduledAt_idx"
  ON "Reminder" ("userId", "status", "scheduledAt");

-- bootstrap 복구가 PENDING·scheduledAt>now 전수 스캔할 때의 보조 인덱스.
CREATE INDEX IF NOT EXISTS "Reminder_scheduledAt_idx"
  ON "Reminder" ("scheduledAt");

-- S80 perf fix: recoverPending(WHERE status='PENDING' ORDER BY scheduledAt) status-first 서빙.
CREATE INDEX IF NOT EXISTS "Reminder_status_scheduledAt_idx"
  ON "Reminder" ("status", "scheduledAt");

-- S80 reviewer H1 fix: /remind 멱등 dedup(부분 NULL distinct — REST NULL 키는 충돌 안 함).
CREATE UNIQUE INDEX IF NOT EXISTS "Reminder_userId_idempotencyKey_key"
  ON "Reminder" ("userId", "idempotencyKey");

-- FK: 계정 삭제 시 리마인더 정리(Cascade). 멱등 가드.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Reminder_userId_fkey'
  ) THEN
    ALTER TABLE "Reminder"
      ADD CONSTRAINT "Reminder_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- FK: 채널 하드삭제 시 발화 컨텍스트만 끊는다(SetNull — 발화 자체는 막지 않음). 멱등 가드.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Reminder_channelId_fkey'
  ) THEN
    ALTER TABLE "Reminder"
      ADD CONSTRAINT "Reminder_channelId_fkey"
      FOREIGN KEY ("channelId") REFERENCES "Channel" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
