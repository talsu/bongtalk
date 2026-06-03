-- S54 (D11 / FR-AM-03/04/05/06/27 + FR-RS-13) — 첨부 도메인 확장 + 업로드 세션 +
-- 읽음 처리 모드.
--
-- 전부 ADDITIVE + reversible. 기존 row 안전(신규 컬럼은 nullable 또는 @default 라
-- backfill 불요). CONCURRENTLY 는 사용하지 않는다 — `prisma migrate deploy` 는 각
-- migration.sql 을 단일 트랜잭션으로 실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션
-- 블록 내 금지)와 비호환이다. 신규 컬럼/테이블이라 인덱싱 대상 행이 0건이므로 일반
-- CREATE INDEX 의 쓰기 잠금은 사실상 즉시 완료된다.
--
-- 전 DDL 을 멱등(IF NOT EXISTS / DO $$)으로 감싼다(s51/s53 패턴 일관). down.sql 이
-- 역순(세션 테이블 DROP → Attachment 컬럼 DROP → UserSettings 컬럼 DROP → enum DROP)
-- 으로 되돌린다. PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. enum 신규 ────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MarkAsReadMode" AS ENUM ('AUTO_FROM_POSITION', 'AUTO_FROM_LATEST', 'MANUAL_FROM_LATEST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Attachment 확장(전부 nullable/@default — additive 무회귀) ─────────────
ALTER TABLE "Attachment"
  ADD COLUMN IF NOT EXISTS "thumbnailKey"     TEXT,
  ADD COLUMN IF NOT EXISTS "storedMimeType"   VARCHAR(127),
  ADD COLUMN IF NOT EXISTS "extension"        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "width"            INTEGER,
  ADD COLUMN IF NOT EXISTS "height"           INTEGER,
  ADD COLUMN IF NOT EXISTS "duration"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "altText"          VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS "isSpoiler"        BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sortOrder"        INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "linkedAt"         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "processingStatus" "AttachmentStatus" NOT NULL DEFAULT 'PENDING';

-- ── 3. UserSettings += markAsReadMode ───────────────────────────────────────
ALTER TABLE "UserSettings"
  ADD COLUMN IF NOT EXISTS "markAsReadMode" "MarkAsReadMode" NOT NULL DEFAULT 'AUTO_FROM_POSITION';

-- ── 4. AttachmentUploadSession 신규 테이블 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "AttachmentUploadSession" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "uploaderId" UUID         NOT NULL,
  "channelId"  UUID         NOT NULL,
  "filename"   VARCHAR(255) NOT NULL,
  "extension"  VARCHAR(20),
  "sizeBytes"  BIGINT       NOT NULL,
  "mimeType"   VARCHAR(127) NOT NULL,
  "storageKey" TEXT         NOT NULL,
  "expiresAt"  TIMESTAMPTZ  NOT NULL,
  "completed"  BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttachmentUploadSession_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "AttachmentUploadSession"
    ADD CONSTRAINT "AttachmentUploadSession_uploaderId_fkey"
    FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AttachmentUploadSession"
    ADD CONSTRAINT "AttachmentUploadSession_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "AttachmentUploadSession_uploaderId_idx"
  ON "AttachmentUploadSession" ("uploaderId");

CREATE INDEX IF NOT EXISTS "AttachmentUploadSession_expiresAt_idx"
  ON "AttachmentUploadSession" ("expiresAt");

-- FR-AM-27: 동시 미완료 세션 카운트 전용 복합 인덱스
-- (WHERE uploaderId=? AND completed=false AND expiresAt>now).
CREATE INDEX IF NOT EXISTS "AttachmentUploadSession_uploaderId_completed_expiresAt_idx"
  ON "AttachmentUploadSession" ("uploaderId", "completed", "expiresAt");
