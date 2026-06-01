-- Reverse of S25 PresencePreference 'invisible' value add.
--
-- PG 는 enum 값을 직접 DROP 할 수 없으므로 enum 을 재생성한다. 'invisible' 을
-- 쓰고 있던 row 는 먼저 'auto' 로 되돌린다(선호값은 재설정 가능한 파생 설정이라
-- 손실 무해 — runtime presence 는 Redis 가 단일 출처라 영향 없음).

-- 1) 사용 중인 'invisible' 선호값을 안전한 기본값으로 되돌린다.
UPDATE "User" SET "presencePreference" = 'auto' WHERE "presencePreference" = 'invisible';

-- 2) DEFAULT 를 잠시 떼고(타입 교체 동안 캐스팅 충돌 방지) enum 을 재생성한다.
ALTER TABLE "User" ALTER COLUMN "presencePreference" DROP DEFAULT;

ALTER TYPE "PresencePreference" RENAME TO "PresencePreference_old";
CREATE TYPE "PresencePreference" AS ENUM ('auto', 'dnd');
ALTER TABLE "User"
  ALTER COLUMN "presencePreference" TYPE "PresencePreference"
  USING ("presencePreference"::text::"PresencePreference");
DROP TYPE "PresencePreference_old";

-- 3) DEFAULT 복원.
ALTER TABLE "User"
  ALTER COLUMN "presencePreference" SET DEFAULT 'auto';
