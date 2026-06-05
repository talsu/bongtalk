-- Reverse of S81c (D15 / FR-SC-09·10) — 커스텀 슬래시 커맨드 CRUD + configurable action.
--
-- 역순으로 되돌린다: (1) FK 제거, (2) createdBy/actionParams/actionType 컬럼 DROP,
-- (3) description/usageHint 를 TEXT 로 원복, (4) CustomActionType enum DROP.
-- 전 단계 IF EXISTS 가드로 멱등하다(up→down→up 안전).
--
-- ★ 완전 가역: 신규 enum 1개 + ADDITIVE 컬럼 3개 + 길이 상한 2개라 다운그레이드 손실은
--   actionType/actionParams/createdBy 값(S81c 이전엔 부재)에 한정된다. 컬럼이 의존하는 enum 을
--   먼저 컬럼 DROP 후 enum DROP 한다(순서 중요 — enum 컬럼이 살아 있으면 DROP TYPE 거부됨).
--   다른 도메인(자격증명·세션·메시징·프로필)은 무영향(이 마이그레이션이 손대지 않음).

-- (1) FK 제거(컬럼 DROP 전).
ALTER TABLE "SlashCommand" DROP CONSTRAINT IF EXISTS "SlashCommand_createdBy_fkey";

-- (2) ADDITIVE 컬럼 제거(actionType 은 enum 의존이라 enum DROP 전에 먼저 제거).
ALTER TABLE "SlashCommand" DROP COLUMN IF EXISTS "createdBy";
ALTER TABLE "SlashCommand" DROP COLUMN IF EXISTS "actionParams";
ALTER TABLE "SlashCommand" DROP COLUMN IF EXISTS "actionType";

-- (3) 길이 상한 원복(VARCHAR → TEXT). 빈/짧은 값이라 무손실.
ALTER TABLE "SlashCommand"
  ALTER COLUMN "description" TYPE TEXT USING "description"::TEXT;
ALTER TABLE "SlashCommand"
  ALTER COLUMN "usageHint" TYPE TEXT USING "usageHint"::TEXT;

-- (4) CustomActionType enum 제거(컬럼 의존 해소 후).
DROP TYPE IF EXISTS "CustomActionType";
