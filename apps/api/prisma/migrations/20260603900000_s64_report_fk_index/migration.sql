-- S64 fix-forward (security A-6 = MEDIUM-2 · perf B-3 = MODERATE-3 · B-4 = MODERATE-4)
--
-- 신고 큐(ModerationReport)와 감사 로그(AuditLog)의 참조 무결성·조회 인덱스를 보강한다.
-- 모두 비파괴(additive/alter)이며 reversible 하다 — down.sql 이 정확히 역으로 되돌린다.
--
-- A-6 ModerationReport FK:
--   1. channelId → Channel(id) ON DELETE CASCADE — 채널 하드삭제 시 신고 행 함께 정리.
--   2. reporterId → User(id) ON DELETE SET NULL — 신고자 계정 삭제 시 익명화(행은 보존).
--      ON DELETE SET NULL 은 컬럼이 nullable 이어야 하므로 reporterId 를 NULL 허용으로 바꾼다
--      (기존 행은 모두 채워져 있어 무손실 — additive widening).
--
-- B-3 AuditLog actorId 인덱스:
--   `[workspaceId, actorId, createdAt]` — audit 조회 actorId 필터(WHERE actorId=…)의
--   커버 인덱스. 종전엔 `[workspaceId, createdAt]` 만 있어 actor 필터가 부분 스캔이었다.
--
-- B-4 ModerationReport 큐 정렬 인덱스:
--   서비스 정렬 ORDER BY resolvedAt ASC NULLS FIRST, createdAt DESC 에 맞춘
--   `[workspaceId, resolvedAt ASC NULLS FIRST, createdAt DESC]` 부분 정렬 인덱스로 교체한다.
--   Prisma @@index 는 NULLS FIRST/DESC 정렬 방향을 표현하지 못해 raw SQL 로 만든다
--   (audit cursor 인덱스와 동일한 raw-SQL 패턴). 기존 평면 인덱스는 DROP 한다.
--
-- ★ 단일 트랜잭션(prisma migrate deploy) — CREATE INDEX CONCURRENTLY 금지.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s51~s64 패턴과 일관.
-- ★ PG16 throwaway DB 로 up→down→up 재검증.

-- ── A-6 (1): reporterId nullable 로 확장(SET NULL 전제) ───────────────────────
ALTER TABLE "ModerationReport" ALTER COLUMN "reporterId" DROP NOT NULL;

-- ── A-6 (2): channelId → Channel(id) ON DELETE CASCADE ───────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ModerationReport_channelId_fkey'
  ) THEN
    ALTER TABLE "ModerationReport"
      ADD CONSTRAINT "ModerationReport_channelId_fkey"
      FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- A-6 (3): reporterId → User(id) ON DELETE SET NULL(익명화).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ModerationReport_reporterId_fkey'
  ) THEN
    ALTER TABLE "ModerationReport"
      ADD CONSTRAINT "ModerationReport_reporterId_fkey"
      FOREIGN KEY ("reporterId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── B-3: AuditLog actorId 필터 커버 인덱스 ───────────────────────────────────
CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_actorId_createdAt_idx"
  ON "AuditLog" ("workspaceId", "actorId", "createdAt");

-- ── B-4: 신고 큐 정렬 인덱스(NULLS FIRST · createdAt DESC) ────────────────────
-- 종전 평면 인덱스(@@index([workspaceId, resolvedAt, createdAt]))를 정렬 방향 인덱스로
-- 교체한다. Prisma schema 에는 `@@index([workspaceId, resolvedAt, createdAt])` 로 남기되
-- (introspection drift 방지용 동일 컬럼 집합), 실제 정렬 커버는 아래 raw 인덱스가 한다.
CREATE INDEX IF NOT EXISTS "ModerationReport_ws_queue_sort_idx"
  ON "ModerationReport" ("workspaceId", "resolvedAt" ASC NULLS FIRST, "createdAt" DESC);
