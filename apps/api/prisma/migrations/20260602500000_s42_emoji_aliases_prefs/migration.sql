-- S42 (D05 / FR-EM05 / FR-PK03 / FR-PK04) — 이모지 별칭 + 사용자/워크스페이스 선호.
--
-- ADDITIVE + reversible. 신규 테이블 3개를 더한다(기존 row 영향 없음 — backfill 불요):
--
--   1. CustomEmojiAlias       — 커스텀 이모지 별칭. 이모지당 ≤10(서비스 enforce),
--                               (workspaceId, alias) unique, CustomEmoji onDelete Cascade.
--   2. UserEmojiPreference     — 사용자별 1행(userId unique). skinTone + 퀵반응 + 최근.
--   3. WorkspaceEmojiConfig    — 워크스페이스별 1행(workspaceId unique). 퀵반응 기본값 +
--                               canMemberUpload(기본 false — S41 ADMIN-only 보존).
--
-- 전 DDL 을 멱등으로 감싼다(s33/s38/s41 IF NOT EXISTS 패턴 일관): 테이블은
-- CREATE TABLE IF NOT EXISTS, 인덱스는 CREATE [UNIQUE] INDEX IF NOT EXISTS, FK 는
-- 제약 존재검사(DO $$ … IF NOT EXISTS (pg_constraint) … ADD CONSTRAINT …).
-- down.sql 이 테이블 ×3 을 DROP 한다(FK·인덱스는 테이블과 함께 사라짐).
-- PG16 throwaway DB 로 up→down→up 검증.

-- 1. CustomEmojiAlias ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CustomEmojiAlias" (
  "id"            UUID NOT NULL,
  "customEmojiId" UUID NOT NULL,
  "workspaceId"   UUID NOT NULL,
  "alias"         VARCHAR(32) NOT NULL,
  "createdBy"     UUID NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomEmojiAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomEmojiAlias_workspaceId_alias_key"
  ON "CustomEmojiAlias" ("workspaceId", "alias");

CREATE INDEX IF NOT EXISTS "CustomEmojiAlias_customEmojiId_idx"
  ON "CustomEmojiAlias" ("customEmojiId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomEmojiAlias_customEmojiId_fkey'
  ) THEN
    ALTER TABLE "CustomEmojiAlias"
      ADD CONSTRAINT "CustomEmojiAlias_customEmojiId_fkey"
      FOREIGN KEY ("customEmojiId") REFERENCES "CustomEmoji"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomEmojiAlias_createdBy_fkey'
  ) THEN
    ALTER TABLE "CustomEmojiAlias"
      ADD CONSTRAINT "CustomEmojiAlias_createdBy_fkey"
      FOREIGN KEY ("createdBy") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- 2. UserEmojiPreference ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "UserEmojiPreference" (
  "id"              UUID NOT NULL,
  "userId"          UUID NOT NULL,
  "defaultSkinTone" INTEGER NOT NULL DEFAULT 1,
  "quickReactions"  JSONB NOT NULL DEFAULT '["👍","❤️","😂"]',
  "recentEmojis"    JSONB NOT NULL DEFAULT '[]',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserEmojiPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserEmojiPreference_userId_key"
  ON "UserEmojiPreference" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserEmojiPreference_userId_fkey'
  ) THEN
    ALTER TABLE "UserEmojiPreference"
      ADD CONSTRAINT "UserEmojiPreference_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- 3. WorkspaceEmojiConfig ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkspaceEmojiConfig" (
  "id"              UUID NOT NULL,
  "workspaceId"     UUID NOT NULL,
  "quickReactions"  JSONB NOT NULL DEFAULT '["👍","❤️","😂"]',
  "canMemberUpload" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceEmojiConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceEmojiConfig_workspaceId_key"
  ON "WorkspaceEmojiConfig" ("workspaceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceEmojiConfig_workspaceId_fkey'
  ) THEN
    ALTER TABLE "WorkspaceEmojiConfig"
      ADD CONSTRAINT "WorkspaceEmojiConfig_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
