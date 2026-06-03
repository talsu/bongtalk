-- S63 (D12 / FR-RM05·06·07) — 모더레이션 역마이그레이션.
--
-- up 이 추가한 BannedMember 테이블과 WorkspaceMember.mutedUntil 컬럼을 역순으로 제거
-- 한다. DROP TABLE 이 종속 인덱스·FK 를 함께 제거하므로 추가 DROP INDEX 는 불필요하나
-- 멱등성을 위해 IF EXISTS 로 감싼다. 데이터 손실(차단 목록·진행 중 타임아웃)은 의도된
-- 역방향 동작이다(테이블/컬럼 신설을 되돌림).

DROP TABLE IF EXISTS "BannedMember";

ALTER TABLE "WorkspaceMember"
  DROP COLUMN IF EXISTS "mutedUntil";
