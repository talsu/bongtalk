-- Reverse of S74 (D14 / FR-PS-04·05·06) — 배너 + DND 옵션 + 워크스페이스별 프로필.
--
-- 역순으로 되돌린다: (1) WorkspaceMemberProfile 테이블 DROP(FK/인덱스는 테이블과 함께
-- 제거됨), (2) User 의 dndDuringStatus / bannerKey 컬럼 DROP. 전 단계 IF EXISTS 가드로
-- 멱등하다.
--
-- ★ 완전 가역: additive 컬럼 2개 + 신규 테이블이라 다운그레이드 손실은 배너/DND 옵션/
--   ws프로필 값에 한정된다. 기존 전역 신원(handle/displayName/avatarKey/bio)·메시징은
--   무영향(이 마이그레이션이 손대지 않음). enum 추가가 없어 DROP TYPE 단계도 불필요하다.

-- (1) WorkspaceMemberProfile 테이블 제거(FK/UNIQUE/인덱스가 테이블과 함께 삭제됨).
DROP TABLE IF EXISTS "WorkspaceMemberProfile";

-- (2) User additive 컬럼 제거.
ALTER TABLE "User" DROP COLUMN IF EXISTS "dndDuringStatus";
ALTER TABLE "User" DROP COLUMN IF EXISTS "bannerKey";
