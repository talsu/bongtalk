-- AUTH-3 down — 비밀번호 재설정 토큰 테이블 롤백(reversible).
--
-- PasswordResetToken 은 전부 신규 additive 자산이라 DROP 으로 원천 데이터를 잃지 않는다
-- (재설정 토큰은 forgot-password 로 언제든 재발급 가능한 휘발성 1h TTL 등록 메타다).
-- FK·인덱스는 테이블과 함께 사라지므로 테이블 1개만 DROP 한다.

DROP TABLE IF EXISTS "PasswordResetToken";
