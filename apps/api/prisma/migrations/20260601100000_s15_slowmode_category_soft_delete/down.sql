-- S15 롤백: 인덱스/컬럼을 역순으로 되돌린다.
--
-- 주의: 부분 유니크를 전체-테이블 유니크로 복원하기 전에 soft-delete 된
-- 동명 카테고리가 남아 있으면 전체 유니크 생성이 실패할 수 있다. 롤백
-- 시점에는 deletedAt 컬럼이 곧 제거되므로, 전체 유니크 복원 전에 soft-delete
-- 행을 물리 삭제해 충돌을 제거한다(데이터가 사라지는 destructive 단계 —
-- 롤백은 이미 destructive 한 작업이라 명시).

-- 3) 부분 유니크 → 전체-테이블 유니크 복원
DROP INDEX IF EXISTS "Category_workspaceId_name_active_uniq";

DELETE FROM "Category" WHERE "deletedAt" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Category_workspaceId_name_key"
  ON "Category"("workspaceId", "name");

-- 2) Category soft-delete 인덱스 + 컬럼
DROP INDEX IF EXISTS "Category_workspaceId_deletedAt_idx";
ALTER TABLE "Category" DROP COLUMN IF EXISTS "deletedAt";

-- 1) slowmodeSeconds 컬럼
ALTER TABLE "Channel" DROP COLUMN IF EXISTS "slowmodeSeconds";
