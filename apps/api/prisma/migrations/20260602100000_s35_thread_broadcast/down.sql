-- S35 down — broadcast partial index + isBroadcast 컬럼 제거(reversible).
-- 컬럼은 additive(NOT NULL DEFAULT false)였으므로 DROP 만으로 원복된다.
-- broadcast 로 생성된 SYSTEM_THREAD_BROADCAST 행 자체는 일반 메시지 행이므로
-- down 에서 삭제하지 않는다(데이터 보존 — 플래그만 제거).
--
-- 인덱스를 컬럼보다 먼저 DROP 한다(인덱스가 isBroadcast 컬럼에 의존하므로).
DROP INDEX IF EXISTS "Message_channel_broadcast_idx";

ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "isBroadcast";
