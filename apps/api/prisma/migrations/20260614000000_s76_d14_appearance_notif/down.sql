-- Reverse of S76 (D14 / FR-PS-09·10) — 외관 설정 + 알림 채널 토글.
--
-- 역순으로 되돌린다: (1) UserSettings 의 additive 컬럼 6개 DROP, (2) Theme/Density
-- enum TYPE DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: 신규 enum 2개 + additive 컬럼 6개라 다운그레이드 손실은 외관/알림채널
--   값에 한정된다. 기존 알림 수준(notifTrigger)·키워드·DND·읽음모드·전역 신원·메시징은
--   무영향(이 마이그레이션이 손대지 않음). 컬럼을 먼저 DROP 한 뒤 enum 을 DROP 한다
--   (enum 을 참조하는 컬럼이 남아 있으면 DROP TYPE 이 실패하므로 순서가 중요).

-- (1) UserSettings additive 컬럼 제거(추가 역순).
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "notifMobile";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "notifDesktop";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "clock24h";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "chatFontSize";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "density";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "theme";

-- (2) 신규 enum TYPE 제거(참조 컬럼이 모두 사라진 뒤이므로 안전).
DROP TYPE IF EXISTS "Density";
DROP TYPE IF EXISTS "Theme";
