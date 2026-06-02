-- S38 down — 2컬럼 + enum 제거(reversible).
--
-- 순서 주의: notificationLevel 컬럼이 ThreadNotificationLevel enum 타입을 참조하므로
-- 컬럼(+인덱스)을 enum 보다 먼저 DROP 한다. 컬럼이 살아있는 채로 DROP TYPE 하면
-- "cannot drop type ... because other objects depend on it" 로 실패한다.
--
-- 인덱스는 컬럼에 종속되므로 컬럼 DROP 시 함께 사라지지만, 명시적으로 먼저 DROP 해
-- 의도를 분명히 한다(idempotent — IF EXISTS).

-- 2. Message.threadLocked (additive 였으므로 DROP 만으로 원복).
ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "threadLocked";

-- 1-c → 1-b → 1: 인덱스 → 컬럼 → enum 역순.
DROP INDEX IF EXISTS "ThreadSubscription_userId_notificationLevel_idx";

ALTER TABLE "ThreadSubscription"
  DROP COLUMN IF EXISTS "notificationLevel";

DROP TYPE IF EXISTS "ThreadNotificationLevel";
