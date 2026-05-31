-- S12 (D02 채널 CRUD) — FR-CH-01 FORUM 타입 + FR-CH-03 채널명 재사용.
--
-- 두 가지 변경:
--  1) ChannelType 에 FORUM 추가 (TEXT/ANNOUNCEMENT/FORUM 생성 가능).
--  2) 워크스페이스 채널명 유니크를 PARTIAL 인덱스로 교체.
--     기존 전체-테이블 UNIQUE(workspaceId,name) 는 soft-delete 된 행도 이름을
--     계속 점유 → 같은 이름 재생성 시 CHANNEL_NAME_TAKEN(409). 부분 유니크
--     `WHERE "deletedAt" IS NULL` 로 교체하면 삭제된 행은 유니크 검사에서
--     빠지므로 삭제 즉시 이름 재사용이 가능하다.
--
-- expand-contract: (2) 는 인덱스 swap 이라 활성(deletedAt IS NULL) 채널의
-- 유니크 보장은 끊김 없이 유지된다(부분 인덱스가 전체 인덱스의 활성 부분집합).
-- DIRECT 채널의 글로벌-DM 부분 유니크(Channel_global_dm_name_uniq)는 별개라
-- 영향 없음. reversible: down.sql 동반.

-- 1) FORUM enum 값 추가 (idempotent)
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'FORUM';

-- 2) 전체-테이블 유니크 제거 → 활성 채널 한정 부분 유니크로 교체
DROP INDEX IF EXISTS "Channel_workspaceId_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_workspaceId_name_active_uniq"
  ON "Channel"("workspaceId", "name")
  WHERE "deletedAt" IS NULL;
