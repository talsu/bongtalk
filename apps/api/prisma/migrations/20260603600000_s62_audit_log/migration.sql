-- S62 (D12 / FR-RM17) — AuditLog (모더레이션/관리 감사 로그).
--
-- append-only 감사 테이블. S63 kick/ban/timeout 이 같은 테이블을 공유한다(action 은
-- 넓은 String enum). 신규 테이블만 추가하는 비파괴(additive) 마이그레이션이라
-- reversible 하다 — down.sql 은 인덱스·FK·테이블을 역순으로 DROP 한다.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s51/s53/s54/s55/s60/s61 패턴과 일관한다.
-- ★ PG16 throwaway DB 로 up→down→up 검증.

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID           NOT NULL,
  "actorId"     UUID           NOT NULL,
  "targetId"    UUID,
  "channelId"   UUID,
  "action"      VARCHAR(64)    NOT NULL,
  "details"     JSONB,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_createdAt_idx"
  ON "AuditLog" ("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_action_createdAt_idx"
  ON "AuditLog" ("workspaceId", "action", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_channelId_createdAt_idx"
  ON "AuditLog" ("channelId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_workspaceId_fkey'
  ) THEN
    ALTER TABLE "AuditLog"
      ADD CONSTRAINT "AuditLog_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
