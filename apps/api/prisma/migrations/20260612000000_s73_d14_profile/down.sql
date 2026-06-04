-- Reverse of S73 전역 프로필 신원 레이어 + 아바타.
--
-- 역순으로 되돌린다: (1) handle UNIQUE 인덱스 DROP, (2) User 의 7개 프로필 컬럼 DROP.
-- 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: additive 신규 컬럼 + 백필이라 다운그레이드 손실은 표시 신원 값
--   (handle/displayName/fullName/pronouns/title/avatarKey/handleChangedAt)에 한정된다.
--   기존 username/email/bio/timezone 등은 무영향(이 마이그레이션이 손대지 않음).
--   enum 추가가 없어 DROP TYPE 단계도 불필요하다(S65/S66 와 동일하게 대칭적).

-- (1) handle UNIQUE 인덱스 제거(별도 비-유니크 인덱스는 더 이상 생성하지 않으므로 단일 DROP).
-- 구버전이 만든 "User_handle_idx" 잔재가 있을 수 있어 멱등 가드로 함께 정리한다.
DROP INDEX IF EXISTS "User_handle_idx";
DROP INDEX IF EXISTS "User_handle_key";

-- (2) 전역 프로필 컬럼 제거.
ALTER TABLE "User" DROP COLUMN IF EXISTS "handleChangedAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "avatarKey";
ALTER TABLE "User" DROP COLUMN IF EXISTS "title";
ALTER TABLE "User" DROP COLUMN IF EXISTS "pronouns";
ALTER TABLE "User" DROP COLUMN IF EXISTS "fullName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "displayName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "handle";
