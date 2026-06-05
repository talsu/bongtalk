-- S79 (D15 / FR-SC-01·02·03) — 슬래시 커맨드 자동완성 토대(커스텀 전용 테이블).
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다. 신규 enum 2개 + 신규 테이블 1개를 추가하며, 기존 테이블/컬럼은 손대지 않는다.
--
--   ResponseType{EPHEMERAL,IN_CHANNEL}  — 커맨드 응답 노출 범위(발신자 전용 / 채널 전체).
--   HandlerType{BUILTIN,INTERNAL_ACTION} — 처리기 종류(순수 텍스트 변환 / 도메인 서비스 호출).
--   SlashCommand                          — 워크스페이스 커스텀 슬래시 커맨드.
--
-- ★ 빌트인 커맨드(/shrug·/me·/status·/dnd·/remind·/giphy 등)는 DB 에 시드하지 않는다 —
--   NestJS BUILTIN_COMMANDS 상수로만 제공한다(Fork B). 따라서 이 테이블은 워크스페이스 커스텀
--   전용이며, S79 시점엔 비어 있다(S81 CRUD 가 채움 — Fork C). GET 목록은 상수+DB커스텀을 병합한다.
--
-- ★ workspaceId 는 NULLABLE 이다(스키마상 NULL=빌트인 슬롯). S79 시점엔 항상 NOT NULL(커스텀)만
--   들어가지만, 향후 확장 여지를 위해 nullable 로 둔다. @@unique([workspaceId,name]) 로 워크스페이스
--   내 커맨드명 중복을 막는다(PostgreSQL 에서 복합 UNIQUE 의 NULL 은 distinct 취급이라 NULL 슬롯끼리는
--   제약을 받지 않으나, S79 는 NULL 행을 만들지 않으므로 무영향).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 트랜잭션 블록에서
--   금지되는 CONCURRENTLY 를 쓰지 않는다(인덱스는 일반 CREATE INDEX).
-- ★ 완전 가역: 신규 enum 2개 + 신규 테이블 1개라 down.sql 은 테이블 DROP → enum DROP 으로 무손실
--   역행한다(s77b "신규 테이블 = 완전 가역" 선례). 다운그레이드 손실은 커스텀 슬래시 커맨드 행에
--   한정되며(S79 시점엔 행이 없음), 다른 도메인은 무영향(이 마이그레이션이 손대지 않음).
-- ★ 멱등 가드(enum 은 DO $$ 블록의 IF NOT EXISTS, 테이블/인덱스는 IF NOT EXISTS)로 up→down→up
--   재적용을 안전하게 한다. PG16 throwaway DB 로 up→down→up 검증.

-- ── enum: ResponseType ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ResponseType') THEN
    CREATE TYPE "ResponseType" AS ENUM ('EPHEMERAL', 'IN_CHANNEL');
  END IF;
END
$$;

-- ── enum: HandlerType ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'HandlerType') THEN
    CREATE TYPE "HandlerType" AS ENUM ('BUILTIN', 'INTERNAL_ACTION');
  END IF;
END
$$;

-- ── table: SlashCommand ─────────────────────────────────────────────────────
-- S79 fix-forward (reviewer MEDIUM): "name" 은 VARCHAR(32) 로 상한한다(Zod
-- SlashCommandItem.name max(32) 정합·list-poison 예방). 이 마이그레이션은 미배포 상태라
-- 직접 편집한다(별도 ALTER 마이그레이션 불필요). down 도 동일 정의로 정합한다.
CREATE TABLE IF NOT EXISTS "SlashCommand" (
  "id"           UUID NOT NULL,
  "workspaceId"  UUID,
  "name"         VARCHAR(32) NOT NULL,
  "description"  TEXT NOT NULL DEFAULT '',
  "usageHint"    TEXT NOT NULL DEFAULT '',
  "responseType" "ResponseType" NOT NULL DEFAULT 'EPHEMERAL',
  "handlerType"  "HandlerType" NOT NULL DEFAULT 'INTERNAL_ACTION',
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlashCommand_pkey" PRIMARY KEY ("id")
);

-- 워크스페이스 내 커맨드명 unique(NULL 슬롯끼리는 distinct — S79 는 NULL 행 미생성).
-- S79 fix-forward (perf MINOR): 별도의 "SlashCommand_workspaceId_idx" 단순 인덱스는
-- 이 복합 UNIQUE 의 좌측 prefix 와 중복이라 생성하지 않는다(UNIQUE 가 workspaceId 조회를
-- 커버). 중복 인덱스 제거로 쓰기 오버헤드/저장 공간을 줄인다.
CREATE UNIQUE INDEX IF NOT EXISTS "SlashCommand_workspaceId_name_key"
  ON "SlashCommand" ("workspaceId", "name");

-- FK: 워크스페이스 삭제 시 커스텀 커맨드 정리(Cascade). 멱등 가드.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SlashCommand_workspaceId_fkey'
  ) THEN
    ALTER TABLE "SlashCommand"
      ADD CONSTRAINT "SlashCommand_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
