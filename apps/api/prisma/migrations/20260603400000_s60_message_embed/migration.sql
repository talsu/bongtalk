-- S60 (D11 / FR-RC07/08/09/21 + FR-AM-13~16) — 링크 unfurl 결과 테이블.
--
-- 신규 테이블 1개(MessageEmbed) + 인덱스 + FK CASCADE. 전부 ADDITIVE + reversible.
-- 기존 row/스키마 무영향(빈 신규 테이블). CONCURRENTLY 는 사용하지 않는다 —
-- `prisma migrate deploy` 는 각 migration.sql 을 단일 트랜잭션으로 실행하므로
-- CREATE INDEX CONCURRENTLY(트랜잭션 블록 내 금지)와 비호환이다. 신규 테이블이라
-- 인덱스 생성은 즉시 완료된다.
--
-- 전 DDL 을 멱등(IF NOT EXISTS / DO $$)으로 감싼다(s51/s53/s54/s55 패턴 일관). down.sql
-- 이 역순으로 되돌린다(DROP TABLE 한 번으로 인덱스·FK 가 함께 사라지지만, 명시적
-- 역순 가드도 둔다). PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. MessageEmbed 신규 테이블 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MessageEmbed" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "messageId"     UUID         NOT NULL,
  "url"           TEXT         NOT NULL,
  "normalizedUrl" TEXT         NOT NULL,
  "cacheKey"      VARCHAR(64)  NOT NULL,
  "title"         TEXT,
  "description"   TEXT,
  "siteName"      VARCHAR(255),
  "imageKey"      VARCHAR(512),
  "statusCode"    INTEGER      NOT NULL,
  "fetchedAt"     TIMESTAMPTZ(6) NOT NULL,
  "suppressedAt"  TIMESTAMPTZ(6),
  "suppressedBy"  UUID,
  -- Prisma @default(now()) 매핑과 일치(앱·DB 동일 기본값).
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageEmbed_pkey" PRIMARY KEY ("id")
);

-- ── 2. 인덱스 ───────────────────────────────────────────────────────────────
-- 동일 메시지 내 동일 정규화 URL(cacheKey) 중복 방지 — upsert 의 충돌 타깃.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageEmbed_messageId_cacheKey_key"
  ON "MessageEmbed" ("messageId", "cacheKey");

-- 메시지별 embed 조회(read-path 조인).
CREATE INDEX IF NOT EXISTS "MessageEmbed_messageId_idx"
  ON "MessageEmbed" ("messageId");

-- cacheKey 단독 조회(운영/GC 보조).
CREATE INDEX IF NOT EXISTS "MessageEmbed_cacheKey_idx"
  ON "MessageEmbed" ("cacheKey");

-- ── 3. FK (Message ON DELETE CASCADE) ───────────────────────────────────────
-- 메시지 hard delete(운영 purge) 시 embed 도 함께 정리된다. soft-delete 는 행을
-- 남기되 read-path(toDto)가 deleted 메시지의 embed 를 [] 로 마스킹한다(서비스 레이어).
DO $$ BEGIN
  ALTER TABLE "MessageEmbed"
    ADD CONSTRAINT "MessageEmbed_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
