-- S64 fix-forward 역마이그레이션(A-6 · B-3 · B-4 되돌리기).
--
-- up 이 추가한 FK·인덱스를 제거하고 reporterId 를 NOT NULL 로 복원한다. 순서는
-- 의존 역순: 정렬 인덱스 → audit 인덱스 → FK → NOT NULL 복원. 모두 IF EXISTS 가드.
--
-- ★ reporterId NOT NULL 복원 전제: SET NULL FK 를 먼저 떼어야(아니면 NULL 행이 생길
--   수 있는 제약과 충돌). 이 down 은 NULL 화된 행이 없는 상태(up 직후)에서 안전하다.

-- B-4: 정렬 인덱스 제거.
DROP INDEX IF EXISTS "ModerationReport_ws_queue_sort_idx";

-- B-3: audit actorId 인덱스 제거.
DROP INDEX IF EXISTS "AuditLog_workspaceId_actorId_createdAt_idx";

-- A-6: FK 제거(channel CASCADE · reporter SET NULL).
ALTER TABLE "ModerationReport" DROP CONSTRAINT IF EXISTS "ModerationReport_reporterId_fkey";
ALTER TABLE "ModerationReport" DROP CONSTRAINT IF EXISTS "ModerationReport_channelId_fkey";

-- A-6: reporterId NOT NULL 복원(SET NULL FK 제거 후 — NULL 행 없음 전제).
ALTER TABLE "ModerationReport" ALTER COLUMN "reporterId" SET NOT NULL;
