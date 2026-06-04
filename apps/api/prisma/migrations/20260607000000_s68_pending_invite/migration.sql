-- S68 (D13 / FR-W04·W04a·W18) — 이메일 직접 초대(보류 초대 테이블).
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다:
--
--   1. WorkspacePendingInvite 테이블 신규(미가입 이메일 초대의 보류 행).
--      - tokenHash CHAR(64) @unique = sha256(rawToken). ★핵심 AC: DB 엔 토큰 평문 없음.
--      - role 은 기존 "WorkspaceRole" enum 재사용(신규 enum 추가 없음).
--      - @@unique([workspaceId, email]) 로 같은 워크스페이스 같은 이메일 1행만 유지.
--   2. 활성 보류 초대 목록 조회용 보조 인덱스(workspaceId, canceledAt, acceptedAt).
--   3. 만료 스캔용 인덱스(expiresAt).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 완전 가역: 신규 테이블 + 인덱스 + FK 라 down.sql 은 DROP TABLE 한 번으로 무손실
--   역행한다(enum 추가 없음 — DROP TYPE 단계 불요. S67 과 동일하게 대칭적).
-- ★ 멱등 가드(IF NOT EXISTS)로 s51/s53/s54/s55/s60/s61/s65/s66/s67 패턴과 일관한다.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. WorkspacePendingInvite 테이블 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkspacePendingInvite" (
  "id"          UUID            NOT NULL,
  "workspaceId" UUID            NOT NULL,
  "email"       VARCHAR(254)    NOT NULL,
  "role"        "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
  "tokenHash"   CHAR(64)        NOT NULL,
  "invitedById" UUID            NOT NULL,
  "expiresAt"   TIMESTAMPTZ(6)  NOT NULL,
  "acceptedAt"  TIMESTAMPTZ(6),
  "canceledAt"  TIMESTAMPTZ(6),
  "lastSentAt"  TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspacePendingInvite_pkey" PRIMARY KEY ("id")
);

-- ── 2. 제약/인덱스 ──────────────────────────────────────────────────────────
-- tokenHash 단건 수락 조회 + 평문 없는 대조의 근거(@unique).
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspacePendingInvite_tokenHash_key"
  ON "WorkspacePendingInvite" ("tokenHash");

-- 같은 워크스페이스에 같은 이메일은 한 행만(재초대 = 기존 행 갱신).
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspacePendingInvite_workspaceId_email_key"
  ON "WorkspacePendingInvite" ("workspaceId", "email");

-- 활성 보류 초대 목록(canceledAt/acceptedAt 둘 다 null) 조회 가속.
CREATE INDEX IF NOT EXISTS "WorkspacePendingInvite_workspaceId_canceledAt_acceptedAt_idx"
  ON "WorkspacePendingInvite" ("workspaceId", "canceledAt", "acceptedAt");

-- 만료 스캔(후속 정리 배치)용.
CREATE INDEX IF NOT EXISTS "WorkspacePendingInvite_expiresAt_idx"
  ON "WorkspacePendingInvite" ("expiresAt");

-- ── 3. 외래키 ───────────────────────────────────────────────────────────────
-- 워크스페이스 삭제 시 보류 초대를 함께 정리(Cascade). 멱등 가드를 위해 DO 블록으로 감싼다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspacePendingInvite_workspaceId_fkey'
  ) THEN
    ALTER TABLE "WorkspacePendingInvite"
      ADD CONSTRAINT "WorkspacePendingInvite_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspacePendingInvite_invitedById_fkey'
  ) THEN
    ALTER TABLE "WorkspacePendingInvite"
      ADD CONSTRAINT "WorkspacePendingInvite_invitedById_fkey"
      FOREIGN KEY ("invitedById") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
