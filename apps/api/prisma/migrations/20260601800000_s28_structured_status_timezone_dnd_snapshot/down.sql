-- Reverse of S28 structured custom status + timezone + DND snapshot.
--
-- 단순 nullable 컬럼 4개 추가의 역연산. emoji/expiresAt/timezone 은 커스텀 상태의
-- 부가 표시값이고 dndScheduleSnapshot 은 auto-toggle 복원용 파생값이라 컬럼을 떼도
-- 도메인 손실이 없다(기존 customStatus 텍스트는 보존). up 의 정확한 역순으로 떼낸다.

ALTER TABLE "User" DROP COLUMN "dndScheduleSnapshot";
ALTER TABLE "User" DROP COLUMN "timezone";
ALTER TABLE "User" DROP COLUMN "customStatusExpiresAt";
ALTER TABLE "User" DROP COLUMN "customStatusEmoji";
