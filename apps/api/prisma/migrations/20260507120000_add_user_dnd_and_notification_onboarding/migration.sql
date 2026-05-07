-- task-046 iter4 (K1, K4): DnD weekly schedule + notification onboarding flag.
--
-- K1 dndSchedule (jsonb) — Discord-parity per-day weekly Do Not Disturb.
--   shape: { "days": [{ "day": 0..6 (Sun..Sat), "startMin": 0..1439, "endMin": 0..1439 }] }
--   null = no schedule. start>end 인 entry 는 "overnight" (예: 23:00 → 07:00).
--   Reversible: DROP COLUMN.
--
-- K4 notificationOnboardingShown (boolean) — 첫 알림 온보딩 노출 여부.
--   default false. PATCH 후 true 로 set 되면 다시 보여주지 않음.
--   Reversible: DROP COLUMN.

ALTER TABLE "User" ADD COLUMN "dndSchedule" JSONB;
ALTER TABLE "User" ADD COLUMN "notificationOnboardingShown" BOOLEAN NOT NULL DEFAULT false;
