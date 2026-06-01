-- Reverse of S27 User.lastSeenAt add.
--
-- 단순 컬럼 추가의 역연산. lastSeenAt 은 멤버 목록의 "마지막 접속" 표기에만
-- 쓰이는 파생 표시값이라(runtime presence 의 단일 출처는 Redis) 컬럼을 떼도
-- 도메인 손실이 없다.

-- 인덱스를 먼저 떼고(존재할 때만) 컬럼을 떼어 up 의 정확한 역순을 따른다.
DROP INDEX IF EXISTS "WorkspaceMember_workspaceId_joinedAt_userId_idx";

ALTER TABLE "User" DROP COLUMN "lastSeenAt";
