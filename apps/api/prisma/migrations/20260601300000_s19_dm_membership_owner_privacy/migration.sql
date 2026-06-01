-- S19 (FR-DM-07/08/09/12) — 그룹 DM 멤버십(가입/탈퇴 시각) + owner 승계 + DM 수신권한.
--
-- expand-contract 안전 규칙: ADDITIVE 만. 신규 enum 1개 + nullable 컬럼 4개
-- (User.allowDmFrom 은 NOT NULL DEFAULT 동반)만 추가하므로 기존 row / 기존 컬럼 /
-- 기존 인덱스는 전혀 건드리지 않는다(회귀 없음). joinedAt / owner 백필은 기존
-- gdm 채널에만 작용하며, leftAt 은 항상 NULL 로 시작해 모든 기존 멤버가 활성
-- 상태를 유지한다.
--
-- ★ 불변 계약(설계 핵심): soft-leave(나가기/강퇴) 시 서비스가 leftAt=now() 와
-- allowMask=0(denyMask=0)을 같은 UPDATE 에서 원자적으로 세팅한다. 그래서 기존
-- 9개 read-path(channel-access DIRECT 분기, room-manager allowMask>0, direct-messages
-- list/listGroups/getGroupMembers, messages resolveDmVisibleFrom, unread.service,
-- me-mentions, me-activity)가 코드 한 줄 안 바꾸고 leaver/kicked 를 즉시 비멤버
-- 취급한다. leftAt 은 1차 판정에 쓰지 않는 보조 컬럼(승계 정렬·감사·재진입)이다.
--
-- Reversible: down.sql 동반(대칭 역순). joinedAt/owner 는 backfill 가능한 파생값,
-- leftAt 은 항상 NULL 시작, allowDmFrom 은 DEFAULT 복원 가능이라 손실 무해.
-- throwaway PG16 에서 up→down→up 검증.

-- (1) DM 수신권한 enum.
CREATE TYPE "DmPrivacy" AS ENUM ('EVERYONE', 'WORKSPACE_MEMBER');

-- (2) User.allowDmFrom — 기존 row 는 DEFAULT 로 WORKSPACE_MEMBER 백필.
ALTER TABLE "User"
    ADD COLUMN "allowDmFrom" "DmPrivacy" NOT NULL DEFAULT 'WORKSPACE_MEMBER';

-- (3) Channel.ownerId — 그룹 DM owner. onDelete SET NULL 로 owner User 하드삭제
--     시 승계 훅 없이 NULL 로 끊긴다(승계 훅은 carryover).
ALTER TABLE "Channel"
    ADD COLUMN "ownerId" UUID;
ALTER TABLE "Channel"
    ADD CONSTRAINT "Channel_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- (4) ChannelPermissionOverride 가입/탈퇴 시각.
ALTER TABLE "ChannelPermissionOverride"
    ADD COLUMN "joinedAt" TIMESTAMPTZ,
    ADD COLUMN "leftAt" TIMESTAMPTZ;

-- (5) joinedAt backfill — 기존 USER 멤버십 row 는 생성 시각을 가입 시각으로 본다.
UPDATE "ChannelPermissionOverride"
   SET "joinedAt" = "createdAt"
 WHERE "principalType" = 'USER'
   AND "joinedAt" IS NULL;

-- (6) owner backfill — 기존 gdm 채널의 owner 를 최古 활성 멤버(joinedAt ASC,
--     동시각이면 createdAt ASC)로 정한다. 1:1 DM(`dm:%`)·일반 채널은 대상 아님.
UPDATE "Channel" c
   SET "ownerId" = sub."principalId"::uuid
  FROM (
        SELECT DISTINCT ON (o."channelId")
               o."channelId",
               o."principalId"
          FROM "ChannelPermissionOverride" o
         WHERE o."principalType" = 'USER'
           AND (o."allowMask" & 1) > 0
         ORDER BY o."channelId", o."joinedAt" ASC, o."createdAt" ASC
       ) sub
 WHERE c.id = sub."channelId"
   AND c.type = 'DIRECT'
   AND c.name LIKE 'gdm:%'
   AND c."ownerId" IS NULL;

-- (7) 활성 멤버 조회 + 승계 정렬용 부분 인덱스. Prisma @@index 가 partial WHERE 를
--     표현할 수 없어 raw SQL 로만 둔다(schema.prisma 의 전체-컬럼 @@index 와 병행).
CREATE INDEX "CPO_dm_active_members_idx"
    ON "ChannelPermissionOverride" ("channelId", "joinedAt")
    WHERE "principalType" = 'USER' AND "leftAt" IS NULL;
