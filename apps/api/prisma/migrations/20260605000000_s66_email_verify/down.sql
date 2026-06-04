-- Reverse of S66 이메일 인증 + 도메인 게이트.
--
-- 역순으로 되돌린다: (1) EmailVerificationToken 테이블 DROP(인덱스/FK 는 테이블과
-- 함께 사라짐), (2) User.emailVerified 컬럼 DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: additive 신규 테이블 + 신규 컬럼이라 다운그레이드 손실은 이메일 인증
--   상태/토큰 이력에 한정된다(기존 User 행·인증과 무관한 컬럼은 무영향). enum 추가가
--   없어 DROP TYPE 단계도 불필요하다(S65 와 동일하게 대칭적).

-- (1) EmailVerificationToken 테이블 제거(token UNIQUE · userId 인덱스 · FK 동반 DROP).
DROP TABLE IF EXISTS "EmailVerificationToken";

-- (2) User.emailVerified 컬럼 제거.
ALTER TABLE "User"
  DROP COLUMN IF EXISTS "emailVerified";
