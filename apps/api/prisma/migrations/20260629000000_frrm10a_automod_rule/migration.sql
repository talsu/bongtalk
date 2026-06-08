-- FR-RM10a (063 / ADR E2): AutoModRule — 리터럴 키워드 모더레이션 규칙.
--
-- 워크스페이스 ADMIN 이 정의한 키워드 집합(소문자 정규화)을 메시지 send/edit 의
-- contentPlain 에 대해 SUBSTRING/WORD 로 평가한다(★정규식 없음 — ReDoS 회피, ADR E1).
-- MENTION_SPAM / REPEAT_SPAM 트리거는 enum 값만 예약하고 미사용(후속 FR-RM10b).
--
-- ADDITIVE · NO CONCURRENTLY(트랜잭션 마이그레이션 정합 · auto-deploy.sh psql -f 호환) ·
-- reversible. 전 DDL 을 멱등으로 감싼다(s85/s86/s88b IF NOT EXISTS / pg_constraint 패턴
-- 일관) — enum 은 DO $$ pg_type 가드, 테이블/인덱스는 IF NOT EXISTS, FK 는 pg_constraint
-- 존재검사.
--
-- down migration (수동 롤백 · 신규 테이블/타입이라 데이터 손실 없이 완전히 되돌아간다):
--   DROP TABLE IF EXISTS "AutoModRule";
--   DROP TYPE IF EXISTS "AutoModMatch";
--   DROP TYPE IF EXISTS "AutoModAction";
--   DROP TYPE IF EXISTS "AutoModTrigger";
-- PG16 throwaway DB 로 up→down→up 검증.

-- 트리거 종류. KEYWORD 만 구현, MENTION_SPAM/REPEAT_SPAM 은 예약(미사용).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutoModTrigger') THEN
    CREATE TYPE "AutoModTrigger" AS ENUM ('KEYWORD', 'MENTION_SPAM', 'REPEAT_SPAM');
  END IF;
END
$$;

-- 매칭 결과 액션.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutoModAction') THEN
    CREATE TYPE "AutoModAction" AS ENUM ('BLOCK', 'ALERT', 'TIMEOUT');
  END IF;
END
$$;

-- 키워드 매칭 모드.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutoModMatch') THEN
    CREATE TYPE "AutoModMatch" AS ENUM ('SUBSTRING', 'WORD');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "AutoModRule" (
  "id"               UUID NOT NULL,
  "workspaceId"      UUID NOT NULL,
  "name"             VARCHAR(100) NOT NULL,
  "triggerType"      "AutoModTrigger" NOT NULL,
  "keywords"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "matchMode"        "AutoModMatch" NOT NULL,
  "action"           "AutoModAction" NOT NULL,
  "timeoutSeconds"   INTEGER,
  "exemptRoleIds"    UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "exemptChannelIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "createdBy"        UUID NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutoModRule_pkey" PRIMARY KEY ("id")
);

-- check 핫패스: 워크스페이스의 enabled 규칙만 로드(캐시 미스 시). 선두 컬럼 적중.
CREATE INDEX IF NOT EXISTS "AutoModRule_workspaceId_enabled_idx"
  ON "AutoModRule" ("workspaceId", "enabled");

-- FK: 워크스페이스 hard-delete 시 규칙도 함께 정리(CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AutoModRule_workspaceId_fkey'
  ) THEN
    ALTER TABLE "AutoModRule"
      ADD CONSTRAINT "AutoModRule_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
