-- S33 롤백: 비정규화 카운터 컬럼을 제거한다.
--
-- 두 컬럼은 read-path 비정규화 캐시일 뿐이며 진리값(실제 답글 수/마지막 답글)은
-- 답글 행 자체로부터 항상 재계산 가능하다. 따라서 DROP COLUMN 은 파생값만
-- 버릴 뿐 원천 데이터를 잃지 않는다(non-destructive — 답글 메시지는 그대로다).
-- 재적용(up) 시 backfill 이 동일 값으로 복원한다.

ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "latestReplyAt",
  DROP COLUMN IF EXISTS "replyCount";
