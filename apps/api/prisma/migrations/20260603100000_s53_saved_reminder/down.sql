-- Reverse of S53 개인 저장함 리마인더.
--
-- 역순으로 되돌린다: (1) partial index DROP, (2) 4개 컬럼 DROP. 전 단계 IF EXISTS
-- 가드. additive 신규 컬럼/인덱스라 다운그레이드 손실은 리마인더 예약/발화/스누즈/메모
-- 상태에 한정된다(기존 SavedMessage 행 + status/messageDeletedAt 은 무영향). 미발화
-- BullMQ delayed job 은 Redis 에 남지만, 다음 발화 시 Processor 가 SavedMessage 조회 후
-- 컬럼 부재로 no-op 가 되거나(스키마 롤백 시) 재배포 후 정상 처리된다.

DROP INDEX IF EXISTS "SavedMessage_reminderAt_idx";

ALTER TABLE "SavedMessage"
  DROP COLUMN IF EXISTS "note",
  DROP COLUMN IF EXISTS "snoozedUntil",
  DROP COLUMN IF EXISTS "reminderFiredAt",
  DROP COLUMN IF EXISTS "reminderAt";
