-- Reverse of S77c (D14 / FR-PS-16·19) — 계정 비활성화/재활성화 + 30일 익명화 토대.
--
-- 역순으로 되돌린다: User 의 비활성화 컬럼 2개(deactivatedAt → isDeactivated)를 DROP 한다.
-- 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: additive 컬럼 2개라 다운그레이드 손실은 비활성화 상태값(isDeactivated/
--   deactivatedAt)에 한정된다. 자격증명(passwordHash/email)·세션(RefreshToken)·메시징·
--   프로필은 무영향(이 마이그레이션이 손대지 않음). 추가 역순으로 DROP 한다.

ALTER TABLE "User" DROP COLUMN IF EXISTS "deactivatedAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "isDeactivated";
