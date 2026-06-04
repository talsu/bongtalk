-- S72 (D13 / FR-W22) — IP soft-block.
--
-- 본 마이그레이션은 ADDITIVE(모두 nullable 컬럼 + 신규 보조 인덱스) + reversible 이며
-- 다음 변경을 한 트랜잭션(prisma migrate deploy)으로 적용한다:
--
--   1. WorkspaceMember 에 ipHash CHAR(64)? 추가. 가입(joinPublic·초대 수락) 시점의
--      요청 IP 해시(sha256 hex)를 기록한다. null = 미상 IP / 레거시 가입.
--   2. BannedMember 에 ipHash CHAR(64)? 추가 + (workspaceId, ipHash) 인덱스. ban 집행 시
--      대상 멤버의 마지막 가입 ipHash 를 복사해 두고, 가입/수락 진입점이 이 인덱스로
--      (workspaceId, ipHash) 매칭을 조회해 soft-block 한다.
--   3. AuditLog 에 ipHash CHAR(64)? 추가 + (workspaceId, ipHash, createdAt) 인덱스.
--      SUSPICIOUS_JOIN / SUSPICIOUS_JOIN_THRESHOLD 액션의 IP 해시를 담고, 24h 내 동일
--      ipHash 의 SUSPICIOUS_JOIN 건수 카운트(threshold 평가)가 이 인덱스를 탄다.
--   4. WorkspaceMemberApplication 에 applicantIpHash CHAR(64)? 추가(reviewer BLOCKER-1).
--      APPLY 는 신청자 IP(submit)와 승인자 IP(approve=admin)가 분리되므로, submit 시점의
--      신청자 IP 해시를 여기 기록했다가 approve 시 WorkspaceMember.ipHash 로 복사한다 —
--      그래야 APPLY 가입자도 ban 시 BannedMember.ipHash 가 채워져 APPLY soft-block 대조가
--      동작한다. 이 W22 마이그레이션은 미머지·미배포라 컬럼을 in-place 확장한다(reversible).
--
-- ★ 모두 nullable additive → 기존 row 영향 없음(backfill 불요). 기존 멤버/차단/감사 row 는
--   ipHash=NULL 이며, NULL 은 어떤 ipHash 와도 매칭되지 않으므로 soft-block 무영향(회귀 0).
-- ★ IP 는 hard-block 하지 않는다(NAT/캐리어 공유 오탐) — userId ban 만 hard. 본 스키마는
--   PUBLIC/INVITE soft-allow + audit, APPLY 차단의 *대조 자료*만 보관한다.
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로 실행하므로
--   CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다(s71 선례).
-- ★ 멱등 가드(IF NOT EXISTS)로 s65/s66/s70/s71 패턴과 일관한다. PG16 throwaway DB 로
--   up→down→up 검증.

-- ── 1. WorkspaceMember.ipHash ───────────────────────────────────────────────
ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "ipHash" CHAR(64);

-- ── 2. BannedMember.ipHash + 대조 인덱스 ────────────────────────────────────
ALTER TABLE "BannedMember" ADD COLUMN IF NOT EXISTS "ipHash" CHAR(64);
CREATE INDEX IF NOT EXISTS "BannedMember_workspaceId_ipHash_idx"
  ON "BannedMember" ("workspaceId", "ipHash");

-- ── 3. AuditLog.ipHash + 24h 카운트 인덱스 ──────────────────────────────────
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "ipHash" CHAR(64);
CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_ipHash_createdAt_idx"
  ON "AuditLog" ("workspaceId", "ipHash", "createdAt");

-- ── 4. WorkspaceMemberApplication.applicantIpHash (reviewer BLOCKER-1) ───────
-- 신청자 IP(submit) ↔ 승인자 IP(approve=admin) 분리 → submit 시점 신청자 IP 해시를
-- 기록했다가 approve 시 WorkspaceMember.ipHash 로 복사한다(인덱스 불요 — 대조는 멤버/
-- BannedMember 의 ipHash 인덱스를 탄다). additive nullable → 기존 신청 row 영향 없음.
ALTER TABLE "WorkspaceMemberApplication" ADD COLUMN IF NOT EXISTS "applicantIpHash" CHAR(64);
