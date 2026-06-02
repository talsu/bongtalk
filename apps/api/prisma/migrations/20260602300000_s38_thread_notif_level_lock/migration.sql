-- S38 (D04 / FR-TH-08 / FR-TH-13) — 스레드 마지막 슬라이스 마이그레이션(2컬럼 + enum).
--
-- 전부 ADDITIVE + reversible 이라 기존 row 가 안전하다(DEFAULT 동반 — 백필 불요):
--
--   1. ThreadNotificationLevel enum (ALL / MENTIONS / OFF)
--      + ThreadSubscription.notificationLevel ThreadNotificationLevel DEFAULT 'ALL'
--      + (userId, notificationLevel) 인덱스.
--      FR-TH-08 벨 드롭다운 + thread.replied fanout 필터(OFF/MENTIONS 제외)에 쓰인다.
--
--   2. Message.threadLocked BOOLEAN NOT NULL DEFAULT false
--      FR-TH-13 OWNER/ADMIN 스레드 잠금. 루트 메시지에만 의미가 있고, 잠긴 스레드의
--      MEMBER 이하 답글 POST 를 controller 가 403 THREAD_LOCKED 로 막는다.
--
-- down.sql 이 컬럼 → enum 순서로 DROP 한다(컬럼이 enum 타입을 참조하므로 enum 을
-- 먼저 DROP 할 수 없다 — 순서 주의). PG16 throwaway DB 로 up→down→up 검증.

-- 1. ThreadNotificationLevel enum.
CREATE TYPE "ThreadNotificationLevel" AS ENUM ('ALL', 'MENTIONS', 'OFF');

-- 1-b. ThreadSubscription.notificationLevel (additive, DEFAULT 'ALL' → 기존 row 안전).
ALTER TABLE "ThreadSubscription"
  ADD COLUMN "notificationLevel" "ThreadNotificationLevel" NOT NULL DEFAULT 'ALL';

-- 1-c. fanout 필터(level != OFF) + Threads 탭 목록의 userId 스코프 조회 보조 인덱스.
CREATE INDEX "ThreadSubscription_userId_notificationLevel_idx"
  ON "ThreadSubscription" ("userId", "notificationLevel");

-- 2. Message.threadLocked (additive, DEFAULT false → 기존 row 안전).
ALTER TABLE "Message"
  ADD COLUMN "threadLocked" BOOLEAN NOT NULL DEFAULT false;
