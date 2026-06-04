-- Reverse of S65 Channel.isDefault 부분 인덱스. 인덱스만 추가한 마이그레이션이라
-- 데이터 손실 없이 완전 가역이다(IF EXISTS 가드로 멱등).

DROP INDEX IF EXISTS "Channel_workspaceId_isDefault_idx";
