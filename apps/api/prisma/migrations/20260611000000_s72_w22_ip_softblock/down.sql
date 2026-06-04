-- S72 (D13 / FR-W22) IP soft-block — DOWN(reversible 검증용).
--
-- up 의 역순으로 인덱스 → 컬럼을 제거한다. 모두 additive nullable 이라 데이터 손실 없이
-- 되돌릴 수 있다(ipHash 컬럼 드롭 시 그 안의 해시값만 사라질 뿐, 그 외 행/컬럼은 무손상).
-- IF EXISTS 가드로 멱등. prisma 가 자동 적용하지는 않으나(현 프로젝트는 forward-only
-- migrate deploy) up→down→up 가역 검증의 정본이며 운영 롤백 절차의 근거다.

DROP INDEX IF EXISTS "AuditLog_workspaceId_ipHash_createdAt_idx";
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "ipHash";

DROP INDEX IF EXISTS "BannedMember_workspaceId_ipHash_idx";
ALTER TABLE "BannedMember" DROP COLUMN IF EXISTS "ipHash";

ALTER TABLE "WorkspaceMember" DROP COLUMN IF EXISTS "ipHash";
