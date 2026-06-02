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
--   5. UserChannelMute."isMuted" BOOLEAN DEFAULT false — 채널 뮤트 여부를
--      mutedUntil 과 분리한 명시 축(S46 fix-forward / BLOCKER 3). 기존에는
--      mutedUntil=null 이 "영구 뮤트"와 "레벨전용 비뮤트(level 만 오버라이드)" 양쪽을
--      뜻해 {level:ALL,isMuted:false} 설정이 채널 영구 차단으로 오작동했다. isMuted 를
--      도입해 muted = isMuted && (mutedUntil null|미래) 로 명확화한다(서버
--      ServerNotificationPref.isMuted 와 대칭). 기존 UserChannelMute 행은 전부
--      S43 뮤트 UI(POST /me/mutes)로 생성된 "실제 뮤트" 이므로 isMuted=true 로
--      backfill 한다(무회귀 — 기존 뮤트가 그대로 활성 유지). S46 미배포 슬라이스라
--      같은 migration 파일에 ADD COLUMN + backfill 을 담는다.
--
--   6. cron 부분 인덱스(HIGH) — 만료 sweep 가 스캔하는 술어를 좁힌다:
--      ServerNotificationPref (isMuted,muteUntil) WHERE isMuted AND muteUntil IS NOT NULL,
--      UserChannelMute (isMuted,mutedUntil) WHERE isMuted AND mutedUntil IS NOT NULL.
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

-- 5. UserChannelMute.isMuted (BLOCKER 3 — 뮤트 축을 mutedUntil 과 분리).
--    DEFAULT false 로 추가한 뒤, "기존" 행(전부 S43 뮤트로 생성)을 isMuted=true 로
--    backfill 한다. 멱등(IF NOT EXISTS)이라 재실행 시 ADD 는 건너뛰지만, backfill
--    UPDATE 는 DEFAULT 인 신규 컬럼 값(false)을 true 로 올리는 1회성이라 재실행
--    안전을 위해 컬럼 존재 직후의 행에만 적용한다. throwaway up→down→up 에서 down
--    이 컬럼을 DROP 하므로 두 번째 up 도 깨끗한 backfill 이 된다.
ALTER TABLE "UserChannelMute"
  ADD COLUMN IF NOT EXISTS "isMuted" BOOLEAN NOT NULL DEFAULT false;

-- 기존 UserChannelMute 행 backfill — S43 뮤트로 생성된 행이므로 isMuted=true.
-- S46 이전 스키마에서는 "행 존재 = 채널 뮤트" 였고, level 컬럼은 바로 위에서 막
-- additive 추가됐으므로 모든 기존 행은 level IS NULL(서버 상속) 상태다. 그 두 조건
-- (isMuted=false ∧ level IS NULL)이 곧 "S46 이전부터 있던 뮤트 행" 을 식별한다.
-- S46 신규 코드(level-only 비뮤트 = isMuted=false ∧ level NOT NULL)는 level 이 박혀
-- 있어 이 backfill 에 걸리지 않는다 — 재실행해도 새 데이터를 덮지 않아 멱등하다.
UPDATE "UserChannelMute"
  SET "isMuted" = true
  WHERE "isMuted" = false AND "level" IS NULL;

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

-- 6. cron 만료 sweep 부분 인덱스(HIGH). sweep 은 "활성 뮤트 + 만료시각 존재" 인
--    소수 행만 스캔하므로 partial index 로 좁힌다(전체 테이블 스캔 회피).
CREATE INDEX IF NOT EXISTS "ServerNotificationPref_mute_expiry_idx"
  ON "ServerNotificationPref" ("isMuted", "muteUntil")
  WHERE "isMuted" AND "muteUntil" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "UserChannelMute_mute_expiry_idx"
  ON "UserChannelMute" ("isMuted", "mutedUntil")
  WHERE "isMuted" AND "mutedUntil" IS NOT NULL;
