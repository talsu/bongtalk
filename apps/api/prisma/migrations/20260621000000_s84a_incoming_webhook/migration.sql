-- S84a (D16 / FR-RC11) — 인커밍 웹훅 / 봇 메시지.
--
-- 신규 테이블 1개(IncomingWebhook) + 인덱스 + FK + Message 에 ADDITIVE nullable 컬럼
-- 3개(webhookId/botUsername/botAvatarUrl) + Message→IncomingWebhook FK(SetNull)
-- + webhookId 인덱스. 전부 ADDITIVE + reversible. 기존 row/스키마 무영향(신규 컬럼은
-- nullable, 신규 테이블은 비어 있음). CONCURRENTLY 미사용 — `prisma migrate deploy`
-- 가 migration.sql 을 단일 트랜잭션으로 실행하므로 비호환(신규 객체라 즉시 완료).
--
-- 전 DDL 을 멱등(IF NOT EXISTS / DO $$)으로 감싼다(s51/s53/s60 패턴 일관). down.sql 이
-- 역순으로 되돌린다. PG16 throwaway DB 로 up→down→up 검증.
--
-- 보안(FR-RC11): tokenHash 는 sha256(rawToken) 의 64-hex 만 저장한다(평문/bcrypt 부재).
-- 검증은 앱 레이어 timingSafeEqual. tokenHash UNIQUE 라 토큰→웹훅 단일 인덱스 조회.

-- ── 1. IncomingWebhook 신규 테이블 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "IncomingWebhook" (
  "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"    UUID           NOT NULL,
  "channelId"      UUID           NOT NULL,
  "name"           VARCHAR(80)    NOT NULL,
  "botDisplayName" VARCHAR(80),
  "avatarUrl"      TEXT,
  "tokenHash"      VARCHAR(64)    NOT NULL,
  "createdBy"      UUID           NOT NULL,
  -- Prisma @default(now()) 매핑과 일치(앱·DB 동일 기본값).
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt"      TIMESTAMPTZ(6),
  "revokedAt"      TIMESTAMPTZ(6),
  "lastUsedAt"     TIMESTAMPTZ(6),
  CONSTRAINT "IncomingWebhook_pkey" PRIMARY KEY ("id")
);

-- ── 2. 인덱스 ───────────────────────────────────────────────────────────────
-- 토큰 해시 유일성 — 인커밍 POST 의 토큰→웹훅 조회 충돌 타깃 + 평문 미저장 보강.
CREATE UNIQUE INDEX IF NOT EXISTS "IncomingWebhook_tokenHash_key"
  ON "IncomingWebhook" ("tokenHash");
-- 워크스페이스/채널별 웹훅 목록 조회.
CREATE INDEX IF NOT EXISTS "IncomingWebhook_workspaceId_idx"
  ON "IncomingWebhook" ("workspaceId");
CREATE INDEX IF NOT EXISTS "IncomingWebhook_channelId_idx"
  ON "IncomingWebhook" ("channelId");

-- ── 3. FK (CASCADE: 워크스페이스/채널 삭제 시 웹훅도 삭제) ────────────────────
DO $$ BEGIN
  ALTER TABLE "IncomingWebhook"
    ADD CONSTRAINT "IncomingWebhook_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IncomingWebhook"
    ADD CONSTRAINT "IncomingWebhook_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 생성자 FK: 기본 RESTRICT(웹훅 소유자 User 는 함부로 삭제되지 않음 — 계정 삭제는
-- 익명화 경로가 별도 처리). Prisma 기본(NoAction)과 정합.
DO $$ BEGIN
  ALTER TABLE "IncomingWebhook"
    ADD CONSTRAINT "IncomingWebhook_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Message ADDITIVE 컬럼 (FR-RC11 봇 메시지 override) ─────────────────────
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "webhookId"    UUID;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "botUsername"  VARCHAR(80);
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "botAvatarUrl" TEXT;

-- 웹훅 삭제 시 메시지는 보존하고 링크만 끊는다(SetNull) — 봇 메시지 본문/표시
-- override(botUsername/botAvatarUrl)는 컬럼에 남아 렌더 가능.
DO $$ BEGIN
  ALTER TABLE "Message"
    ADD CONSTRAINT "Message_webhookId_fkey"
    FOREIGN KEY ("webhookId") REFERENCES "IncomingWebhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 웹훅 삭제 SetNull 역참조 + 웹훅별 메시지 조회 보조.
CREATE INDEX IF NOT EXISTS "Message_webhookId_idx" ON "Message" ("webhookId");
