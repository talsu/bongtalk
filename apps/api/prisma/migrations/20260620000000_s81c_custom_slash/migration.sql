-- S81c (D15 / FR-SC-09·10) — 워크스페이스 커스텀 슬래시 커맨드 CRUD + configurable action.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다. 신규 enum 1개 + 기존 SlashCommand 테이블에 컬럼 추가/타입 상한만 한다 —
-- 다른 테이블/도메인은 손대지 않는다.
--
--   CustomActionType{EPHEMERAL_TEXT,SEND_TEMPLATE,REDIRECT_CHANNEL}
--       — 커스텀 커맨드 실행 액션 종류. ★외부 URL/webhook 호출 없음(PRD·SSRF 회피).
--   SlashCommand.actionType    "CustomActionType"  NULL  — 커스텀 행에만 채워짐.
--   SlashCommand.actionParams  JSONB               NULL  — actionType 별 파라미터.
--   SlashCommand.createdBy     UUID                NULL  — 등록 관리자(FK User onDelete SetNull).
--   SlashCommand.description   VARCHAR(255)              — TEXT → VARCHAR(255) 상한(CRUD Zod 정합).
--   SlashCommand.usageHint     VARCHAR(128)              — TEXT → VARCHAR(128) 상한.
--
-- ★ prod SlashCommand 테이블은 비어 있다(빌트인은 코드 카탈로그·DB 미적재, 커스텀 CRUD 는
--   본 S81c 가 도입). 따라서 description/usageHint 의 VARCHAR 상한 tighten 은 기존 행 절단
--   위험이 없다(additive type tighten — 안전).
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 CONCURRENTLY 를
--   쓰지 않는다(트랜잭션 블록에서 금지됨). FK 는 일반 ADD CONSTRAINT.
-- ★ 완전 가역: 신규 enum 1개 + ADDITIVE 컬럼 3개 + 길이 상한 2개라 down.sql 은 컬럼 DROP →
--   VARCHAR 원복(TEXT) → enum DROP 으로 무손실 역행한다(역순). 다운그레이드 손실은 actionType/
--   actionParams/createdBy 값에 한정되며(S81c 이전엔 부재했던 정보) 다른 도메인은 무영향.
-- ★ 멱등 가드(enum 은 DO $$ IF NOT EXISTS, 컬럼은 ADD COLUMN IF NOT EXISTS, FK 는 pg_constraint
--   존재 확인)로 up→down→up 재적용을 안전하게 한다. PG16 throwaway DB 로 up→down→up 검증.

-- ── enum: CustomActionType ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CustomActionType') THEN
    CREATE TYPE "CustomActionType" AS ENUM ('EPHEMERAL_TEXT', 'SEND_TEMPLATE', 'REDIRECT_CHANNEL');
  END IF;
END
$$;

-- ── SlashCommand: 길이 상한(TEXT → VARCHAR) ──────────────────────────────────
-- prod 테이블이 비어 있어 절단 위험 없음. USING 으로 명시 캐스트(빈 행이라 무손실).
ALTER TABLE "SlashCommand"
  ALTER COLUMN "description" TYPE VARCHAR(255) USING "description"::VARCHAR(255);
ALTER TABLE "SlashCommand"
  ALTER COLUMN "usageHint" TYPE VARCHAR(128) USING "usageHint"::VARCHAR(128);

-- ── SlashCommand: configurable action + 등록자 컬럼(ADDITIVE) ─────────────────
ALTER TABLE "SlashCommand" ADD COLUMN IF NOT EXISTS "actionType" "CustomActionType";
ALTER TABLE "SlashCommand" ADD COLUMN IF NOT EXISTS "actionParams" JSONB;
ALTER TABLE "SlashCommand" ADD COLUMN IF NOT EXISTS "createdBy" UUID;

-- FK: 등록 관리자 → User. 계정 하드삭제 시 SetNull(커맨드는 워크스페이스 자산이라 행 보존).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SlashCommand_createdBy_fkey'
  ) THEN
    ALTER TABLE "SlashCommand"
      ADD CONSTRAINT "SlashCommand_createdBy_fkey"
      FOREIGN KEY ("createdBy") REFERENCES "User" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
