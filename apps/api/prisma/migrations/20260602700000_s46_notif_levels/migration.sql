-- S46 (D06 / ADR-6 / FR-MN-05/06/07/08) — 알림 설정/레벨 (NotifLevel 3계층).
--
-- 전부 ADDITIVE + reversible 이라 기존 row 가 안전하다(DEFAULT 동반 / nullable —
-- 백필 불요):
--
--   1. NotifLevel enum (ALL / MENTIONS / NOTHING) — ADR-6 카노니컬 3값.
--
--   2. UserSettings — 사용자 글로벌 알림 설정. userId @unique, notifTrigger
--      NotifLevel DEFAULT 'MENTIONS', keywords TEXT[] DEFAULT '{}', dndUntil/
--      dndSchedule nullable. 행이 없으면 resolve 가 MENTIONS 로 폴백하므로 backfill
--      불요. user onDelete Cascade.
--
--   3. ServerNotificationPref — 서버(워크스페이스) 단위 오버라이드.
--      (userId, workspaceId) unique, level DEFAULT 'MENTIONS', isMuted DEFAULT
--      false, muteUntil nullable, suppressEveryone/suppressRoleMentions DEFAULT
--      false. user/workspace onDelete Cascade.
--
--   4. UserChannelMute."level" NotifLevel NULL — 채널 단위 레벨 오버라이드.
--      nullable(NULL = 서버 상속) 이라 기존 UserChannelMute 행은 NULL 로 안전하다
--      (additive — S43 뮤트 UI·S22 사이드바·멘션 fanout 무회귀). 신규
--      ChannelNotificationPref 테이블을 만들지 않는 교란-최소 deviation.
--
-- 전 DDL 을 멱등으로 감싼다(s38/s43 패턴 일관): enum 은 pg_type 존재검사
-- (DO $$ … CREATE TYPE …), 테이블은 CREATE TABLE IF NOT EXISTS, 컬럼은 ADD COLUMN
-- IF NOT EXISTS, 인덱스는 CREATE [UNIQUE] INDEX IF NOT EXISTS, FK 는 pg_constraint
-- 존재검사 후 ADD CONSTRAINT. down.sql 이 컬럼 → 테이블 → enum 순서로 DROP 한다
-- (테이블/컬럼이 enum 타입을 참조하므로 enum 을 먼저 DROP 할 수 없다 — 순서 주의).
-- PG16 throwaway DB 로 up→down→up 검증.

-- 1. NotifLevel enum (CREATE TYPE 은 IF NOT EXISTS 미지원 → pg_type 가드).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotifLevel') THEN
    CREATE TYPE "NotifLevel" AS ENUM ('ALL', 'MENTIONS', 'NOTHING');
  END IF;
END
$$;

-- 2. UserSettings — 글로벌 알림 설정.
CREATE TABLE IF NOT EXISTS "UserSettings" (
  "id"           UUID NOT NULL,
  "userId"       UUID NOT NULL,
  "notifTrigger" "NotifLevel" NOT NULL DEFAULT 'MENTIONS',
  "keywords"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "dndUntil"     TIMESTAMPTZ,
  "dndSchedule"  JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserSettings_userId_key"
  ON "UserSettings" ("userId");

-- 3. ServerNotificationPref — 서버 단위 오버라이드.
CREATE TABLE IF NOT EXISTS "ServerNotificationPref" (
  "id"                   UUID NOT NULL,
  "userId"               UUID NOT NULL,
  "workspaceId"          UUID NOT NULL,
  "level"                "NotifLevel" NOT NULL DEFAULT 'MENTIONS',
  "isMuted"              BOOLEAN NOT NULL DEFAULT false,
  "muteUntil"            TIMESTAMPTZ,
  "suppressEveryone"     BOOLEAN NOT NULL DEFAULT false,
  "suppressRoleMentions" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServerNotificationPref_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServerNotificationPref_userId_workspaceId_key"
  ON "ServerNotificationPref" ("userId", "workspaceId");

CREATE INDEX IF NOT EXISTS "ServerNotificationPref_workspaceId_idx"
  ON "ServerNotificationPref" ("workspaceId");

-- 4. UserChannelMute.level (additive nullable → 기존 row 는 NULL=서버 상속).
ALTER TABLE "UserChannelMute"
  ADD COLUMN IF NOT EXISTS "level" "NotifLevel";

-- FK 가드 (제약 존재검사 후 ADD).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserSettings_userId_fkey'
  ) THEN
    ALTER TABLE "UserSettings"
      ADD CONSTRAINT "UserSettings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServerNotificationPref_userId_fkey'
  ) THEN
    ALTER TABLE "ServerNotificationPref"
      ADD CONSTRAINT "ServerNotificationPref_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServerNotificationPref_workspaceId_fkey'
  ) THEN
    ALTER TABLE "ServerNotificationPref"
      ADD CONSTRAINT "ServerNotificationPref_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
