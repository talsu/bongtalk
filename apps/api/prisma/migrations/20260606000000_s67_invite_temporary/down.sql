-- Reverse of S67 임시 멤버십 초대.
--
-- 역순으로 되돌린다: (1) WorkspaceMember (workspaceId, isTemporary) 인덱스 DROP,
-- (2) WorkspaceMember.isTemporary 컬럼 DROP, (3) Invite.temporary 컬럼 DROP.
-- 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: additive 신규 컬럼 + 신규 인덱스라 다운그레이드 손실은 임시 멤버십
--   표식(어떤 멤버/초대가 임시였는지)에 한정된다. enum/테이블 추가가 없어 DROP TYPE
--   단계도 불필요하다(S65/S66 과 동일하게 대칭적).

-- (1) 임시 멤버 강퇴 배치용 보조 인덱스 제거.
DROP INDEX IF EXISTS "WorkspaceMember_workspaceId_isTemporary_idx";

-- (2) WorkspaceMember.isTemporary 컬럼 제거.
ALTER TABLE "WorkspaceMember"
  DROP COLUMN IF EXISTS "isTemporary";

-- (3) Invite.temporary 컬럼 제거.
ALTER TABLE "Invite"
  DROP COLUMN IF EXISTS "temporary";
