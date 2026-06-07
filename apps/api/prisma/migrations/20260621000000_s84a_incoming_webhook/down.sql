-- Reverse of S84a 인커밍 웹훅 / 봇 메시지.
--
-- 역순: (1) Message FK/인덱스/컬럼 DROP, (2) IncomingWebhook FK DROP, (3) 인덱스 DROP,
-- (4) TABLE DROP. DROP TABLE 만으로 의존 객체가 함께 사라지지만, 명시 역순 + IF EXISTS
-- 가드로 부분 적용 상태에서도 안전하게 되돌린다. 다운그레이드 손실은 신규 웹훅·봇
-- 메시지 override 에 한정되며 기존 USER/SYSTEM Message 행은 무영향.

-- 4. Message ADDITIVE 컬럼/FK/인덱스 역순
DROP INDEX IF EXISTS "Message_webhookId_idx";
DO $$ BEGIN
  ALTER TABLE "Message" DROP CONSTRAINT "Message_webhookId_fkey";
EXCEPTION WHEN undefined_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
ALTER TABLE "Message" DROP COLUMN IF EXISTS "botAvatarUrl";
ALTER TABLE "Message" DROP COLUMN IF EXISTS "botUsername";
ALTER TABLE "Message" DROP COLUMN IF EXISTS "webhookId";

-- 3. IncomingWebhook FK 역순
DO $$ BEGIN
  ALTER TABLE "IncomingWebhook" DROP CONSTRAINT "IncomingWebhook_createdBy_fkey";
EXCEPTION WHEN undefined_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "IncomingWebhook" DROP CONSTRAINT "IncomingWebhook_channelId_fkey";
EXCEPTION WHEN undefined_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "IncomingWebhook" DROP CONSTRAINT "IncomingWebhook_workspaceId_fkey";
EXCEPTION WHEN undefined_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- 2. 인덱스 DROP
DROP INDEX IF EXISTS "IncomingWebhook_channelId_idx";
DROP INDEX IF EXISTS "IncomingWebhook_workspaceId_idx";
DROP INDEX IF EXISTS "IncomingWebhook_tokenHash_key";

-- 1. TABLE DROP
DROP TABLE IF EXISTS "IncomingWebhook";
