-- S69 (D13 / FR-W10) down — WorkspaceMember.invitedById 역행(무손실).
--
-- up 의 역순: FK 제약을 먼저 떨군 뒤 컬럼을 제거한다. nullable additive 컬럼이라
-- 데이터 손실은 invitedById 값(초대자 이력)뿐이며 멤버십 자체는 보존된다.
-- 인덱스는 up 에서 생성하지 않았으므로 DROP 대상이 없다.

ALTER TABLE "WorkspaceMember"
  DROP CONSTRAINT IF EXISTS "WorkspaceMember_invitedById_fkey";

ALTER TABLE "WorkspaceMember"
  DROP COLUMN IF EXISTS "invitedById";
