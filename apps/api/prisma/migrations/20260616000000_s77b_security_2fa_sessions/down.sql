-- Reverse of S77b (D14 / FR-PS-15·20) — 보안: TOTP 2FA + 세션 관리.
--
-- 역순으로 되돌린다: (1) BackupCode 테이블 DROP(FK·인덱스 동반 제거), (2) RefreshToken
-- 의 lastSeenAt DROP, (3) User 의 TOTP 컬럼 2개 DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: additive 컬럼 3개 + 신규 테이블 1개라 다운그레이드 손실은 2FA/백업코드/
--   lastSeenAt 값에 한정된다. 자격증명(passwordHash/email)·세션(RefreshToken 본체)·메시징·
--   프로필은 무영향(이 마이그레이션이 손대지 않음). 테이블을 먼저 DROP 한 뒤(FK 의존) 컬럼을
--   DROP 한다(순서가 중요).

-- (1) BackupCode 테이블 제거(FK·인덱스 CASCADE 동반).
DROP TABLE IF EXISTS "BackupCode";

-- (2) RefreshToken lastSeenAt 제거.
ALTER TABLE "RefreshToken" DROP COLUMN IF EXISTS "lastSeenAt";

-- (3) User TOTP 컬럼 제거(추가 역순).
ALTER TABLE "User" DROP COLUMN IF EXISTS "totpEnabled";
ALTER TABLE "User" DROP COLUMN IF EXISTS "totpSecretEnc";
