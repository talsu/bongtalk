-- S74 (D14 / FR-PS-04·05·06) — 프로필 배너 + 커스텀상태 DND 옵션 + 워크스페이스별 프로필.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다:
--
--   1. User 에 nullable/default additive 컬럼 2개:
--      bannerKey(TEXT NULL) — FR-PS-04 배너 MinIO 키(전역, presignGet 으로 URL 파생).
--      dndDuringStatus(BOOLEAN NOT NULL DEFAULT false) — FR-PS-05 커스텀상태 만료 시 DND
--      동시 활성화 옵션. 기존 row 는 default false 로 backfill(무회귀 — 옵션 미설정 = 종전 동작).
--   2. WorkspaceMemberProfile 신규 테이블(FR-PS-06 · Fork2 Option B): 멤버별 워크스페이스
--      프로필 오버라이드(nickname≤32 · avatarKey · workspaceBio≤190). workspace/user 모두
--      onDelete Cascade FK + @@unique([workspaceId,userId])(이 UNIQUE btree 가 멤버목록
--      LEFT JOIN lookup 도 가속 — 동일 컬럼 보조 인덱스는 중복이라 두지 않는다).
--      신규 테이블이라 기존 데이터 무영향.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 트랜잭션
--   블록에서 금지되는 CREATE INDEX/ADD COLUMN ... CONCURRENTLY 를 쓰지 않는다.
-- ★ 완전 가역: additive 컬럼 2개 + 신규 테이블이라 down.sql 은 테이블 DROP + 컬럼 DROP 으로
--   무손실 역행한다(enum 추가 없음 — DROP TYPE 단계 불요). 다운그레이드 손실은 배너/DND
--   옵션/ws프로필 값에 한정되며 전역 신원·메시징은 무영향.
-- ★ 멱등 가드(IF [NOT] EXISTS / DO$ 조건부 ADD CONSTRAINT)로 s69/s70/s73 패턴과 일관.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. User additive 컬럼 ───────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannerKey"       TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dndDuringStatus" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. WorkspaceMemberProfile 테이블 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkspaceMemberProfile" (
  "id"           UUID         NOT NULL,
  "workspaceId"  UUID         NOT NULL,
  "userId"       UUID         NOT NULL,
  "nickname"     VARCHAR(32),
  "avatarKey"    TEXT,
  "workspaceBio" VARCHAR(190),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceMemberProfile_pkey" PRIMARY KEY ("id")
);

-- 멤버당 워크스페이스별 단일 프로필(upsert 대상). 이 UNIQUE 인덱스가 (workspaceId,userId)
-- btree 를 제공하므로 멤버목록 LEFT JOIN lookup 도 이 인덱스로 가속된다. 동일 컬럼 조합의
-- 별도 보조 인덱스(_workspaceId_userId_idx)는 중복이라 만들지 않는다(perf minor fix-forward).
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceMemberProfile_workspaceId_userId_key"
  ON "WorkspaceMemberProfile" ("workspaceId", "userId");

-- workspaceId → Workspace(id) FK (ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMemberProfile_workspaceId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMemberProfile"
      ADD CONSTRAINT "WorkspaceMemberProfile_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- userId → User(id) FK (ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMemberProfile_userId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMemberProfile"
      ADD CONSTRAINT "WorkspaceMemberProfile_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
