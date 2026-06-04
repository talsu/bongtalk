-- S69 (D13 / FR-W10) — 멤버 디렉터리: WorkspaceMember.invitedById(초대자) 추가.
--
-- 본 마이그레이션은 ADDITIVE + nullable + reversible 이며 단일 트랜잭션(prisma migrate
-- deploy)으로 적용한다:
--
--   1. WorkspaceMember."invitedById" UUID NULL 컬럼 추가(IF NOT EXISTS). 기존 row 는
--      자동 NULL backfill(공개 가입/레거시 — 초대자 없음). accept 경로가 이후 가입분에
--      링크초대(invite.createdById)·이메일초대(pending.invitedById)를 기록한다.
--   2. invitedById → User(id) FK(ON DELETE SET NULL). 초대자 계정 삭제 시 멤버 행은
--      유지하되 FK 만 정리한다(초대 이력 소실 < 멤버십 보존 우선).
--
-- ★ 인덱스 재확인(중복 회피): 역할 필터(@@index([workspaceId, role]))와 가입일 정렬
--   (@@index([workspaceId, joinedAt, userId]))은 S27/S61 에서 이미 존재하므로 신규
--   생성하지 않는다(schema.prisma 기존 인덱스로 디렉터리 검색/필터/정렬이 충족된다).
--   invitedById 자체 인덱스는 디렉터리 조회 경로(workspaceId 스코프 + 본문 join)에서
--   불필요하므로 추가하지 않는다(쓰기 비용 회피).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 트랜잭션
--   블록에서 금지되는 CREATE INDEX/ADD COLUMN ... CONCURRENTLY 를 쓰지 않는다.
-- ★ 완전 가역: down.sql 이 FK DROP → COLUMN DROP 으로 무손실 역행한다(enum 추가 없음).
-- ★ 멱등 가드(IF NOT EXISTS / 조건부 ADD CONSTRAINT)로 s66/s67/s68 패턴과 일관.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. invitedById 컬럼(nullable · additive) ────────────────────────────────
ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "invitedById" UUID;

-- ── 2. invitedById → User(id) FK(ON DELETE SET NULL) ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceMember_invitedById_fkey'
  ) THEN
    ALTER TABLE "WorkspaceMember"
      ADD CONSTRAINT "WorkspaceMember_invitedById_fkey"
      FOREIGN KEY ("invitedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
