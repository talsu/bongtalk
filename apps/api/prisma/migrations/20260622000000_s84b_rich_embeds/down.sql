-- Reverse of S84b 봇/웹훅 rich embed 배열.
-- 단일 ADDITIVE 컬럼 DROP. 다운그레이드 손실은 봇/웹훅 메시지의 rich embed 에 한정되며
-- 기존 USER/SYSTEM/BOT(content) Message 행은 무영향.
ALTER TABLE "Message" DROP COLUMN IF EXISTS "richEmbeds";
