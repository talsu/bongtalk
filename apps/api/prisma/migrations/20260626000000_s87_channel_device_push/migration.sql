-- S87 (FR-MN-18) — 채널별 데스크톱/모바일 독립 push 토글.
--
-- ADDITIVE + reversible. UserChannelMute 에 nullable 컬럼 2개(pushDesktop/pushMobile)를
-- 더한다(기존 row 영향 없음 — NULL=글로벌 notifDesktop/notifMobile 상속이라 backfill 불요·
-- 무회귀). effective 산정은 push.processor 가 pushDesktop ?? notifDesktop ?? true(mobile
-- 동일)로 하며, 둘 다 false 면 push skip 한다(NotifLevel/뮤트/DND/멤버십/read 게이트는 유지).
--
-- 전 DDL 을 멱등으로 감싼다(s85/s86 IF NOT EXISTS 패턴 일관): ADD COLUMN IF NOT EXISTS ×2.
-- NO CONCURRENTLY(트랜잭션 마이그레이션 정합). down.sql 이 두 컬럼을 DROP 한다.
-- PG16 throwaway DB 로 up→down→up 검증.

ALTER TABLE "UserChannelMute" ADD COLUMN IF NOT EXISTS "pushDesktop" BOOLEAN;
ALTER TABLE "UserChannelMute" ADD COLUMN IF NOT EXISTS "pushMobile" BOOLEAN;
