-- S01 (ADR-2 카노니컬 additive 토대) — FR-RC01/RC02/RC17 · FR-RT-18.
--
-- expand-contract 안전 규칙: 이번 슬라이스는 ADDITIVE 만. 신규 컬럼은 전부
-- nullable 또는 default 동반이라 라이브 DB 의 기존 row 가 안전하다. 기존
-- `content` / `contentPlain` 컬럼/타입/PK 는 건드리지 않는다(병행 유지).
-- cuid2 PK 전환과 raw/ast 백필은 별도 트랙(이번 범위 아님).
--
-- 새 컬럼만 추가하므로 lock 비용이 작다(CONCURRENTLY 불필요). 신규 인덱스는
-- 기존 row 를 커버해야 하므로 일반 CREATE INDEX 를 사용한다(prod 대용량 시
-- 이 마이그레이션을 CONCURRENTLY 변형으로 분리할 수 있으나, 단일 NAS / 현
-- 데이터량 기준 불필요).
--
-- prisma migrate dev diff 에는 기존 raw-SQL 마이그레이션과 prisma 정규형
-- 사이의 drift(FK drop/recreate, 인덱스 rename, timestamptz→timestamp,
-- search_tsv DROP DEFAULT 등)가 섞여 나오는데, 그건 본 슬라이스 범위가
-- 아니므로 모두 제거했고 S01 의 순수 additive 변경분만 남겼다.
--
-- Reversible: down.sql 동반(enum DROP + 컬럼 DROP + 인덱스 DROP).

-- CreateEnum (ADR-2): Message author classification. BOT / SYSTEM 은 후속
-- 슬라이스(webhooks / system messages)에서 사용. 기본 USER.
CREATE TYPE "AuthorType" AS ENUM ('USER', 'BOT', 'SYSTEM');

-- AlterTable (ADR-2 카노니컬 컬럼 additive). 전부 nullable 또는 default.
ALTER TABLE "Message"
  ADD COLUMN "contentRaw"     TEXT,
  ADD COLUMN "contentAst"     JSONB,
  ADD COLUMN "contentPlainV2" TEXT,
  ADD COLUMN "version"        INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN "seq"            BIGINT,
  ADD COLUMN "authorType"     "AuthorType" NOT NULL DEFAULT 'USER';

-- CreateIndex (ADR-2 / FR-RT-18): 단순 ID 조회 보조 + cuid2 커서(id DESC) 경로.
-- (channelId, createdAt, id) 페이지네이션 인덱스는 기존 마이그레이션에 이미 존재.
CREATE INDEX "Message_channelId_id_idx" ON "Message"("channelId", "id");
