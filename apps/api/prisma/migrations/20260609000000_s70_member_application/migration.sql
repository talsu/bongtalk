-- S70 (D13 / FR-W06·W06a·W12) — 가입 신청(APPLY 모드) 큐.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 다음 변경을 한 트랜잭션(prisma
-- migrate deploy)으로 적용한다:
--
--   1. ApplicationStatus enum 신규(PENDING/APPROVED/REJECTED/INTERVIEW/WITHDRAWN).
--   2. WorkspaceMemberApplication 테이블 신규(uuid PK · workspaceId FK CASCADE ·
--      applicantId FK CASCADE · status enum DEFAULT PENDING · answers JSONB ·
--      reviewedById FK SET NULL · reviewNote VARCHAR(500)? · interviewChannelId UUID? ·
--      createdAt · updatedAt). 유니크: (workspaceId, applicantId, status). 인덱스:
--      (workspaceId, status), (applicantId).
--
-- 기존 테이블은 변경하지 않는다(isTemporary/joinMode/Invite.temporary 는 S67/S65 에서
-- 이미 추가됨 — FR-W12 임시멤버 강퇴는 그 컬럼을 읽기만 한다). 따라서 신규 enum +
-- 신규 테이블만 더하는 순수 additive 변경이라 backfill 불요다.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ enum 가역성: ApplicationStatus enum 을 **신규 생성**하고 그 enum 을 쓰는 컬럼
--   (status)도 함께 추가하므로, down.sql 은 테이블을 먼저 DROP 한 뒤 enum TYPE 을
--   DROP 할 수 있다(S65 의 "신규 enum = 완전 가역" 선례). PG16 throwaway DB 로
--   up→down→up 검증.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 s51/s53/s54/s55/s60/s61/s65/s66 패턴과 일관한다.

-- ── 1. ApplicationStatus enum 신규 ──────────────────────────────────────────
-- CREATE TYPE 은 IF NOT EXISTS 를 지원하지 않으므로 DO $$ 가드로 멱등화한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApplicationStatus') THEN
    CREATE TYPE "ApplicationStatus" AS ENUM (
      'PENDING', 'APPROVED', 'REJECTED', 'INTERVIEW', 'WITHDRAWN'
    );
  END IF;
END
$$;

-- ── 2. WorkspaceMemberApplication 테이블 신규 ───────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkspaceMemberApplication" (
  "id"                 UUID                NOT NULL,
  "workspaceId"        UUID                NOT NULL,
  "applicantId"        UUID                NOT NULL,
  "status"             "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "answers"            JSONB               NOT NULL,
  "reviewedById"       UUID,
  "reviewNote"         VARCHAR(500),
  "interviewChannelId" UUID,
  "createdAt"          TIMESTAMPTZ(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMPTZ(6)      NOT NULL,

  CONSTRAINT "WorkspaceMemberApplication_pkey" PRIMARY KEY ("id")
);

-- (workspaceId, applicantId, status) 유니크 — 같은 조합당 1행(PRD). 서비스가 PENDING
-- 중복을 선조회 409 로 막고, WITHDRAWN/REJECTED 후 재신청은 그 행을 PENDING 으로 UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceMemberApplication_workspaceId_applicantId_status_key"
  ON "WorkspaceMemberApplication" ("workspaceId", "applicantId", "status");

-- ADMIN 목록(status 필터) 조회 가속.
CREATE INDEX IF NOT EXISTS "WorkspaceMemberApplication_workspaceId_status_idx"
  ON "WorkspaceMemberApplication" ("workspaceId", "status");

-- 본인 상태(me · polling) 조회 가속.
CREATE INDEX IF NOT EXISTS "WorkspaceMemberApplication_applicantId_idx"
  ON "WorkspaceMemberApplication" ("applicantId");

-- workspaceId FK — 워크스페이스 hard-delete 시 신청 행도 함께 정리(ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMemberApplication_workspaceId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMemberApplication"
      ADD CONSTRAINT "WorkspaceMemberApplication_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- applicantId FK — 신청자 계정 하드삭제 시 신청 행도 함께 정리(ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMemberApplication_applicantId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMemberApplication"
      ADD CONSTRAINT "WorkspaceMemberApplication_applicantId_fkey"
      FOREIGN KEY ("applicantId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- reviewedById FK — 검토자 계정 하드삭제 시 이력은 남기고 FK 만 끊는다(ON DELETE SET NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMemberApplication_reviewedById_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMemberApplication"
      ADD CONSTRAINT "WorkspaceMemberApplication_reviewedById_fkey"
      FOREIGN KEY ("reviewedById") REFERENCES "User" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
