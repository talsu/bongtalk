-- S61 (D12 / FR-RM01·02·03·04·15) — 커스텀 Role 시스템.
--
-- 본 마이그레이션은 4개의 변경을 한 트랜잭션(prisma migrate deploy)으로 적용한다.
--   1. WorkspaceRole enum 에 MODERATOR · GUEST 값 추가(3단계 → 5단계).
--   2. Role · MemberRole 신규 테이블 + 인덱스 + FK Cascade.
--   3. ChannelPermissionOverride.allowMask/denyMask 를 Int → BigInt 로 전환
--      (기존 0~0xFF 값은 무손실 승격).
--   4. 1회성 backfill: 워크스페이스마다 시스템 5역할(Role)을 시드하고, 기존
--      WorkspaceMember.role enum 을 동등한 MemberRole 행으로 이전한다.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ enum 가역성: PostgreSQL 은 enum 값 DROP 을 지원하지 않는다(ALTER TYPE ... DROP
--   VALUE 불가). 따라서 down.sql 은 MODERATOR/GUEST 값을 enum 에서 제거하지 않고,
--   해당 값을 쓰는 row 를 안전한 인접 값으로 되돌린 뒤(MODERATOR→MEMBER,
--   GUEST→MEMBER) 신규 테이블/컬럼 변경만 역으로 되돌린다. 신규 enum 값은 미사용
--   상태로 남아 무해하다(재-up 시 다시 사용). 이 비대칭은 PG 제약상 불가피하다.
-- ★ 멱등 가드(IF NOT EXISTS / DO $$)로 감싸 s51/s53/s54/s55/s60 패턴과 일관한다.
-- ★ PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. WorkspaceRole enum 5단계 확장 ───────────────────────────────────────
-- ADD VALUE IF NOT EXISTS 는 멱등하다. 위치 지정(BEFORE/AFTER)으로 논리적 서열을
-- 맞춘다(OWNER > ADMIN > MODERATOR > MEMBER > GUEST). enum 정렬 순서는 비교에
-- 쓰지 않으므로(애플리케이션 ROLE_RANK 사용) 위치는 가독성 목적이다.
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'MODERATOR' AFTER 'ADMIN';
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'GUEST' AFTER 'MEMBER';

-- ── 2. ChannelPermissionOverride.allow/denyMask Int → BigInt ────────────────
-- USING 캐스트로 기존 정수 값을 무손실 승격한다(0~0xFF 범위라 안전).
ALTER TABLE "ChannelPermissionOverride"
  ALTER COLUMN "allowMask" SET DATA TYPE BIGINT USING "allowMask"::bigint,
  ALTER COLUMN "denyMask"  SET DATA TYPE BIGINT USING "denyMask"::bigint;

-- ── 3. Role 신규 테이블 ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Role" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID           NOT NULL,
  "name"        VARCHAR(64)    NOT NULL,
  "colorHex"    CHAR(7),
  "position"    INTEGER        NOT NULL,
  "permissions" BIGINT         NOT NULL DEFAULT 0,
  "isSystem"    BOOLEAN        NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Role_workspaceId_name_key"
  ON "Role" ("workspaceId", "name");
CREATE INDEX IF NOT EXISTS "Role_workspaceId_position_idx"
  ON "Role" ("workspaceId", "position");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Role_workspaceId_fkey'
  ) THEN
    ALTER TABLE "Role"
      ADD CONSTRAINT "Role_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 4. MemberRole 신규 테이블 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "MemberRole" (
  "workspaceId" UUID           NOT NULL,
  "userId"      UUID           NOT NULL,
  "roleId"      UUID           NOT NULL,
  "assignedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedBy"  UUID,
  CONSTRAINT "MemberRole_pkey" PRIMARY KEY ("workspaceId", "userId", "roleId")
);

CREATE INDEX IF NOT EXISTS "MemberRole_roleId_idx"
  ON "MemberRole" ("roleId");
CREATE INDEX IF NOT EXISTS "MemberRole_workspaceId_userId_idx"
  ON "MemberRole" ("workspaceId", "userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MemberRole_workspaceId_userId_fkey'
  ) THEN
    ALTER TABLE "MemberRole"
      ADD CONSTRAINT "MemberRole_workspaceId_userId_fkey"
      FOREIGN KEY ("workspaceId", "userId")
      REFERENCES "WorkspaceMember"("workspaceId", "userId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MemberRole_roleId_fkey'
  ) THEN
    ALTER TABLE "MemberRole"
      ADD CONSTRAINT "MemberRole_roleId_fkey"
      FOREIGN KEY ("roleId") REFERENCES "Role"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 5. backfill: 워크스페이스마다 시스템 5역할 시드 ─────────────────────────
-- permissions BigInt 는 shared-types SYSTEM_ROLE_PERMISSIONS 와 동일 값이다.
-- ★ ADMINISTRATOR = 1<<63 = 9223372036854775808 은 PostgreSQL signed bigint
--   최대값(9223372036854775807)을 1 초과한다. 따라서 64비트 패턴이 동일한 음수
--   표현 -9223372036854775808 로 저장한다(two's-complement). 애플리케이션은
--   permissions 를 읽을 때 BigInt.asUintN(64, raw) 로 부호 없는 논리값(1<<63)을
--   복원한다(permissions.ts toStoragePermissions/fromStoragePermissions).
--   다른 비트(0x1FFF 이하)는 양수라 그대로 저장된다.
--   OWNER     = ADMINISTRATOR(1<<63) → 저장 -9223372036854775808
--   ADMIN     = 0x1FFF = 8191
--   MODERATOR = 0x1CFF = 7423 (ADMIN 에서 MANAGE_CHANNEL·MANAGE_WEBHOOKS 제외)
--   MEMBER    = 0x0C77 = 3191
--   GUEST     = 0x0027 = 39
-- position: OWNER 500 / ADMIN 400 / MODERATOR 300 / MEMBER 200 / GUEST 100.
INSERT INTO "Role" ("id", "workspaceId", "name", "colorHex", "position", "permissions", "isSystem", "createdAt", "updatedAt")
SELECT gen_random_uuid(), w."id", sr.name, NULL, sr.position, sr.permissions, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Workspace" w
CROSS JOIN (
  VALUES
    ('OWNER',     500, (-9223372036854775808)::bigint),
    ('ADMIN',     400, 8191::bigint),
    ('MODERATOR', 300, 7423::bigint),
    ('MEMBER',    200, 3191::bigint),
    ('GUEST',     100, 39::bigint)
) AS sr(name, position, permissions)
ON CONFLICT ("workspaceId", "name") DO NOTHING;

-- ── 6. backfill: 기존 WorkspaceMember.role → MemberRole 행 이전 ─────────────
-- 멤버의 현재 enum 역할에 해당하는 시스템 Role 을 찾아 MemberRole 을 만든다.
-- assignedBy 는 NULL(시스템 backfill). 멱등(ON CONFLICT DO NOTHING).
INSERT INTO "MemberRole" ("workspaceId", "userId", "roleId", "assignedAt", "assignedBy")
SELECT wm."workspaceId", wm."userId", r."id", CURRENT_TIMESTAMP, NULL
FROM "WorkspaceMember" wm
JOIN "Role" r
  ON r."workspaceId" = wm."workspaceId"
 AND r."name" = wm."role"::text
 AND r."isSystem" = true
ON CONFLICT ("workspaceId", "userId", "roleId") DO NOTHING;
