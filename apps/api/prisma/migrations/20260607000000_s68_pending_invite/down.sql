-- Reverse of S68 이메일 직접 초대(보류 초대 테이블).
--
-- 역순으로 되돌린다: FK + 인덱스는 DROP TABLE 이 함께 제거하므로 테이블 한 번의
-- DROP 으로 무손실 역행한다. enum 추가가 없어 DROP TYPE 단계가 불필요하다(WorkspaceRole
-- 은 기존 enum 재사용 — S67 과 동일하게 대칭적).
--
-- ★ 완전 가역: 신규 테이블이라 다운그레이드 손실은 발송된 보류 초대 행에 한정된다
--   (이미 가입된 멤버/링크 초대 Invite 는 별도 테이블이라 무영향).

DROP TABLE IF EXISTS "WorkspacePendingInvite";
