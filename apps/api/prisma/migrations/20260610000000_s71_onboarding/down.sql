-- S71 (D13 / FR-W07·W08·W09) down — 완전 가역.
--
-- 신규 enum + 신규 테이블 3개 + WorkspaceMember 신규 컬럼 3개만 더한 additive
-- 마이그레이션이므로, 테이블/컬럼을 먼저 DROP 한 뒤 enum TYPE 을 DROP 해 무손실
-- 역행한다(S70 의 "신규 enum = 완전 가역" 선례). 테이블 DROP 이 FK 제약·인덱스를
-- 함께 제거하므로 별도 DROP 은 불요하다. enum 은 의존 컬럼(OnboardingQuestion.type)이
-- 사라진 뒤라야 DROP 가능하다.

-- WorkspaceMember 온보딩 진행 컬럼 제거.
ALTER TABLE "WorkspaceMember" DROP COLUMN IF EXISTS "onboardingAnswers";
ALTER TABLE "WorkspaceMember" DROP COLUMN IF EXISTS "onboardingCompletedAt";
ALTER TABLE "WorkspaceMember" DROP COLUMN IF EXISTS "rulesAcceptedAt";

-- 온보딩 카탈로그 테이블 제거(FK·인덱스 동반 DROP).
DROP TABLE IF EXISTS "WorkspaceWelcome";
DROP TABLE IF EXISTS "OnboardingQuestion";
DROP TABLE IF EXISTS "WorkspaceRule";

-- enum 은 의존 컬럼이 사라진 뒤 DROP.
DROP TYPE IF EXISTS "QuestionType";
