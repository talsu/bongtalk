-- S67 (D13 / FR-W02·W03·W12) — 임시 멤버십 초대.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 다음 변경을 단일 트랜잭션
-- (prisma migrate deploy)으로 적용한다:
--
--   1. Invite 에 temporary BOOLEAN NOT NULL DEFAULT false 추가.
--      기존 row 는 default false 로 backfill 된다(임시 표식만 추가 — 무회귀).
--   2. WorkspaceMember 에 isTemporary BOOLEAN NOT NULL DEFAULT false 추가.
--      기존 멤버는 false 로 backfill(영구 멤버 — 강퇴 대상 아님).
--   3. WorkspaceMember (workspaceId, isTemporary) 보조 인덱스 신규.
--      S70 의 연결 종료 강퇴 배치가 임시 멤버만 빠르게 스캔한다(FR-W12).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 완전 가역: additive 신규 컬럼 + 신규 인덱스라 down.sql 은 인덱스 DROP + 컬럼
--   DROP 으로 무손실 역행한다(enum/테이블 추가 없음 — S65/S66 과 동일하게 대칭적).
-- ★ 멱등 가드(IF NOT EXISTS)로 s51/s53/s54/s55/s60/s61/s65/s66 패턴과 일관한다.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. Invite.temporary 컬럼 추가 ───────────────────────────────────────────
ALTER TABLE "Invite"
  ADD COLUMN IF NOT EXISTS "temporary" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. WorkspaceMember.isTemporary 컬럼 추가 ────────────────────────────────
ALTER TABLE "WorkspaceMember"
  ADD COLUMN IF NOT EXISTS "isTemporary" BOOLEAN NOT NULL DEFAULT false;

-- ── 3. 임시 멤버 강퇴 배치(S70 / FR-W12)용 보조 인덱스 ──────────────────────
CREATE INDEX IF NOT EXISTS "WorkspaceMember_workspaceId_isTemporary_idx"
  ON "WorkspaceMember" ("workspaceId", "isTemporary");
