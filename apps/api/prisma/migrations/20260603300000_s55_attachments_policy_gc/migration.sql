-- S55 (D11 / FR-AM-17/20/29 + FR-CH-18) — 첨부 정책 + orphan GC 인덱스.
--
-- 전부 ADDITIVE + reversible. 기존 row 안전(신규 컬럼은 @default 또는 nullable,
-- 신규 테이블은 빈 상태). CONCURRENTLY 는 사용하지 않는다 — `prisma migrate deploy`
-- 는 각 migration.sql 을 단일 트랜잭션으로 실행하므로 CREATE INDEX CONCURRENTLY
-- (트랜잭션 블록 내 금지)와 비호환이다. 인덱싱 대상이 신규/소량 행이라 일반 CREATE
-- INDEX 의 쓰기 잠금은 사실상 즉시 완료된다.
--
-- 전 DDL 을 멱등(IF NOT EXISTS / DO $$)으로 감싼다(s51/s53/s54 패턴 일관). down.sql
-- 이 역순으로 되돌린다. PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. Channel += fileUploadEnabled / maxFileSizeBytes (additive 무회귀) ─────
ALTER TABLE "Channel"
  ADD COLUMN IF NOT EXISTS "fileUploadEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxFileSizeBytes"  BIGINT;

-- ── 2. WorkspaceSetting 신규 테이블(1:1 Workspace) ──────────────────────────
CREATE TABLE IF NOT EXISTS "WorkspaceSetting" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"       UUID        NOT NULL,
  "maxFileSizeBytes"  BIGINT,
  "blockedExtensions" TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceSetting_workspaceId_key"
  ON "WorkspaceSetting" ("workspaceId");

DO $$ BEGIN
  ALTER TABLE "WorkspaceSetting"
    ADD CONSTRAINT "WorkspaceSetting_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Attachment GC / 후처리 partial 인덱스 ────────────────────────────────
-- (a) 후처리 워커(S57+ 썸네일/AV)가 미처리 첨부를 스캔하는 partial 인덱스.
CREATE INDEX IF NOT EXISTS "Attachment_processingStatus_pending_idx"
  ON "Attachment" ("processingStatus")
  WHERE "processingStatus" IN ('PENDING', 'PROCESSING');

-- (b) orphan GC partial 인덱스 — 미연결(messageId NULL OR linkedAt NULL) 첨부를
-- createdAt 순으로 배치 스캔한다(GC 의 WHERE 절과 정합).
CREATE INDEX IF NOT EXISTS "Attachment_orphan_createdAt_idx"
  ON "Attachment" ("createdAt")
  WHERE "messageId" IS NULL OR "linkedAt" IS NULL;

-- (c) 만료 미완료 세션 GC partial 인덱스 — completed=false 세션을 expiresAt 순으로
-- 스캔한다(만료 세션 정리 배치).
CREATE INDEX IF NOT EXISTS "AttachmentUploadSession_open_expiresAt_idx"
  ON "AttachmentUploadSession" ("expiresAt")
  WHERE "completed" = false;
