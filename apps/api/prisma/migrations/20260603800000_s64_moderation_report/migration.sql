-- S64 (D12 / FR-RM11) — 메시지 신고 큐(ModerationReport).
--
-- 비파괴(additive) 변경: ModerationReport 테이블 신규 1개만 추가한다. 기존 테이블/
-- 컬럼을 건드리지 않으므로 reversible 하다 — down.sql 이 테이블·인덱스·FK 를 DROP 한다.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s51/s53/s54/s55/s60/s61/s62/s63 패턴과 일관한다.
-- ★ TIMESTAMPTZ(6) 정밀도는 기존 컨벤션(AuditLog/BannedMember)을 따른다.
-- ★ (messageId, reporterId) 복합 유니크로 같은 신고자의 중복 신고를 막는다.
-- ★ category/resolvedAction 은 넓은 String(VARCHAR) — shared-types Zod 가 값을 검증.
-- ★ PG16 throwaway DB 로 up→down→up 검증.

CREATE TABLE IF NOT EXISTS "ModerationReport" (
  "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"    UUID           NOT NULL,
  "messageId"      UUID           NOT NULL,
  "channelId"      UUID           NOT NULL,
  "reporterId"     UUID           NOT NULL,
  "category"       VARCHAR(32)    NOT NULL,
  "reason"         VARCHAR(512),
  "resolvedAction" VARCHAR(32),
  "resolvedBy"     UUID,
  "resolvedAt"     TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModerationReport_pkey" PRIMARY KEY ("id")
);

-- 같은 신고자의 같은 메시지 중복 신고 방지(@@unique([messageId, reporterId])).
CREATE UNIQUE INDEX IF NOT EXISTS "ModerationReport_messageId_reporterId_key"
  ON "ModerationReport" ("messageId", "reporterId");

-- 신고 큐 조회: 미처리 우선(resolvedAt) + 최신순(createdAt) 인덱스.
CREATE INDEX IF NOT EXISTS "ModerationReport_workspaceId_resolvedAt_createdAt_idx"
  ON "ModerationReport" ("workspaceId", "resolvedAt", "createdAt");

-- 메시지별 신고 조회 보조.
CREATE INDEX IF NOT EXISTS "ModerationReport_messageId_idx"
  ON "ModerationReport" ("messageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ModerationReport_workspaceId_fkey'
  ) THEN
    ALTER TABLE "ModerationReport"
      ADD CONSTRAINT "ModerationReport_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ModerationReport_messageId_fkey'
  ) THEN
    ALTER TABLE "ModerationReport"
      ADD CONSTRAINT "ModerationReport_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
