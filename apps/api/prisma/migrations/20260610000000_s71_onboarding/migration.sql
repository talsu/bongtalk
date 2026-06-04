-- S71 (D13 / FR-W07·W08·W09·W09a) — 워크스페이스 온보딩(규칙 동의·관심사·웰컴).
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 다음 변경을 한 트랜잭션(prisma
-- migrate deploy)으로 적용한다:
--
--   1. QuestionType enum 신규(SINGLE/MULTI/SHORT_TEXT).
--   2. WorkspaceRule 테이블 신규(uuid PK · workspaceId FK CASCADE · position ·
--      title VARCHAR(100) · description VARCHAR(500)? · createdAt). 유니크:
--      (workspaceId, position) — 이 UNIQUE 인덱스가 조회/정렬을 커버하므로 별도
--      일반 인덱스는 두지 않는다(perf MINOR 리뷰 — redundant index 제거).
--   3. OnboardingQuestion 테이블 신규(uuid PK · workspaceId FK CASCADE · position ·
--      type enum · isRequired · label VARCHAR(200) · options JSONB · createdAt).
--      인덱스: (workspaceId, position).
--   4. WorkspaceWelcome 테이블 신규(workspaceId PK+FK CASCADE · welcomeChannelId
--      FK SET NULL · message VARCHAR(500)? · todos JSONB?).
--   5. WorkspaceMember 에 rulesAcceptedAt TIMESTAMPTZ(6)? · onboardingCompletedAt
--      TIMESTAMPTZ(6)? · onboardingAnswers JSONB? 컬럼 추가(모두 nullable).
--
-- ★ Fork A-1: 기존 멤버 backfill 없음. rulesAcceptedAt/onboardingCompletedAt 는
--   nullable 이고 null = 미진행이다. 기존 멤버는 규칙이 생성되기 전까지 게이트
--   무영향(WorkspaceRule 부재 → send/react 게이트 무동작) — 회귀 0.
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ enum 가역성: QuestionType enum 을 **신규 생성**하고 그 enum 을 쓰는 컬럼(type)도
--   함께 추가하므로, down.sql 은 테이블을 먼저 DROP 한 뒤 enum TYPE 을 DROP 할 수
--   있다(S70 의 "신규 enum = 완전 가역" 선례). PG16 throwaway DB 로 up→down→up 검증.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s65/s66/s70 패턴과 일관한다.

-- ── 1. QuestionType enum 신규 ───────────────────────────────────────────────
-- CREATE TYPE 은 IF NOT EXISTS 를 지원하지 않으므로 DO $$ 가드로 멱등화한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuestionType') THEN
    CREATE TYPE "QuestionType" AS ENUM ('SINGLE', 'MULTI', 'SHORT_TEXT');
  END IF;
END
$$;

-- ── 2. WorkspaceRule 테이블 신규 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkspaceRule" (
  "id"          UUID           NOT NULL,
  "workspaceId" UUID           NOT NULL,
  "position"    INTEGER        NOT NULL,
  "title"       VARCHAR(100)   NOT NULL,
  "description" VARCHAR(500),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkspaceRule_pkey" PRIMARY KEY ("id")
);

-- perf MINOR (S71 리뷰): UNIQUE 인덱스가 (workspaceId, position) 조회·정렬을 커버하므로
-- 동일 컬럼의 일반 인덱스는 중복(redundant)이라 생성하지 않는다(WorkspaceRule_workspaceId_position_idx 제거).
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceRule_workspaceId_position_key"
  ON "WorkspaceRule" ("workspaceId", "position");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceRule_workspaceId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceRule"
      ADD CONSTRAINT "WorkspaceRule_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── 3. OnboardingQuestion 테이블 신규 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OnboardingQuestion" (
  "id"          UUID           NOT NULL,
  "workspaceId" UUID           NOT NULL,
  "position"    INTEGER        NOT NULL,
  "type"        "QuestionType" NOT NULL,
  "isRequired"  BOOLEAN        NOT NULL DEFAULT false,
  "label"       VARCHAR(200)   NOT NULL,
  "options"     JSONB          NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OnboardingQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OnboardingQuestion_workspaceId_position_idx"
  ON "OnboardingQuestion" ("workspaceId", "position");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingQuestion_workspaceId_fkey'
  ) THEN
    ALTER TABLE "OnboardingQuestion"
      ADD CONSTRAINT "OnboardingQuestion_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── 4. WorkspaceWelcome 테이블 신규(workspaceId 가 PK — 1:1) ─────────────────
CREATE TABLE IF NOT EXISTS "WorkspaceWelcome" (
  "workspaceId"      UUID NOT NULL,
  "welcomeChannelId" UUID,
  "message"          VARCHAR(500),
  "todos"            JSONB,

  CONSTRAINT "WorkspaceWelcome_pkey" PRIMARY KEY ("workspaceId")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceWelcome_workspaceId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceWelcome"
      ADD CONSTRAINT "WorkspaceWelcome_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- welcomeChannelId FK — 입장 메시지 채널 하드삭제 시 웰컴 설정은 유지하고 참조만 끊는다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceWelcome_welcomeChannelId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceWelcome"
      ADD CONSTRAINT "WorkspaceWelcome_welcomeChannelId_fkey"
      FOREIGN KEY ("welcomeChannelId") REFERENCES "Channel" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── 5. WorkspaceMember 온보딩 진행 컬럼(additive · nullable · backfill 없음) ───
ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "rulesAcceptedAt"       TIMESTAMPTZ(6);
ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMPTZ(6);
ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "onboardingAnswers"     JSONB;
