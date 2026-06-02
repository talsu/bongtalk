-- S51 (D10 / FR-PS-05 · FR-PS-07) — 핀 권한 채널 토글 + 개인 저장함.
--
-- ADDITIVE + reversible. 세 가지를 더한다(기존 row 안전 — backfill 불요):
--
--   1. Channel.memberCanPin  BOOLEAN NOT NULL DEFAULT true — 핀 권한 채널 오버라이드.
--      true = 채널 멤버 전체 허용, false = MODERATOR/ADMIN 이상으로 제한. DEFAULT true 라
--      기존 채널은 종전과 동일하게 멤버 전체 허용으로 백필된다(무회귀). PIN_MESSAGE(0x80)
--      집행 비트는 사용하지 않고 이 컬럼을 게이트가 직접 검사한다(MENTION_EVERYONE 0x80
--      과 충돌 회피 — D12).
--
--   2. SaveStatus enum (IN_PROGRESS / ARCHIVED / COMPLETED) — Slack Later 3탭 대응.
--
--   3. SavedMessage 테이블 — (userId, messageId) unique 로 중복 저장 방지(idempotent),
--      status 3탭 필터, messageDeletedAt 비정규화(원본 soft-delete 시 수동 동기화),
--      user/message onDelete Cascade. `(userId, status, savedAt DESC)` 복합 인덱스가
--      목록 조회를 커버하고 `(messageId)` 인덱스가 soft-delete 동기화 updateMany 를 커버한다.
--
-- 전 DDL 을 멱등으로 감싼다(s42/s43 IF NOT EXISTS 패턴 일관). enum 은 DO 가드로
-- 존재검사 후 CREATE TYPE, 컬럼은 ADD COLUMN IF NOT EXISTS, 테이블은 CREATE TABLE
-- IF NOT EXISTS, 인덱스는 CREATE [UNIQUE] INDEX IF NOT EXISTS, FK 는 pg_constraint
-- 존재검사. down.sql 이 역순(테이블 → enum → 컬럼)으로 되돌린다. PG16 throwaway DB 로
-- up→down→up 검증.

-- 1. Channel.memberCanPin (additive, DEFAULT true 백필).
ALTER TABLE "Channel"
  ADD COLUMN IF NOT EXISTS "memberCanPin" BOOLEAN NOT NULL DEFAULT true;

-- 2. SaveStatus enum.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SaveStatus') THEN
    CREATE TYPE "SaveStatus" AS ENUM ('IN_PROGRESS', 'ARCHIVED', 'COMPLETED');
  END IF;
END
$$;

-- 3. SavedMessage 테이블. gen_random_uuid() 는 PG13+ 코어(pgcrypto 불요).
CREATE TABLE IF NOT EXISTS "SavedMessage" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"           UUID NOT NULL,
  "messageId"        UUID NOT NULL,
  "status"           "SaveStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "messageDeletedAt" TIMESTAMPTZ,
  "savedAt"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavedMessage_userId_messageId_key"
  ON "SavedMessage" ("userId", "messageId");

CREATE INDEX IF NOT EXISTS "SavedMessage_userId_status_savedAt_idx"
  ON "SavedMessage" ("userId", "status", "savedAt" DESC);

CREATE INDEX IF NOT EXISTS "SavedMessage_messageId_idx"
  ON "SavedMessage" ("messageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavedMessage_userId_fkey'
  ) THEN
    ALTER TABLE "SavedMessage"
      ADD CONSTRAINT "SavedMessage_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SavedMessage_messageId_fkey'
  ) THEN
    ALTER TABLE "SavedMessage"
      ADD CONSTRAINT "SavedMessage_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
