import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import {
  readBitVisibleSql,
  mentionMatchSql,
  roleOverridePrincipalMatchSql,
} from '../common/acl/read-visibility.sql';

/**
 * S47 (D06 / FR-MN-14 / FR-MN-20): 서버(워크스페이스) 단위 알림 배지 집계.
 *
 * `GET /me/notification-badges` 와 WS `notification:badge_update` 가 공유하는 단일
 * 출처다. 워크스페이스별 `{ mentionCount, unreadCount }` 를 반환하되, **isMuted
 * 채널/서버는 카운트에서 제외**한다(FR-MN-14: "isMuted=true 채널·서버는 배지 완전
 * 숨김 — 카운트 증가 자체 건너뜀"). `/me/unread-totals`(UnreadService.cachedWorkspaceTotal)
 * 와 역할이 다르다 — 그쪽은 사이드바 레일의 *읽지 않음* 집계(뮤트 무관)이고, 본 서비스는
 * 알림 배지(뮤트 제외)의 진실값이다.
 *
 * ── 뮤트 제외 규칙 (S46 정합) ──
 *   서버 뮤트  = ServerNotificationPref.isMuted=true && (muteUntil null=영구 | >now)
 *               → 해당 워크스페이스 전체가 카운트 0(채널 순회 자체 스킵).
 *   채널 뮤트  = UserChannelMute.isMuted=true && (mutedUntil null=영구 | >now)
 *               → 해당 채널만 카운트에서 제외(나머지 채널은 합산).
 * 만료된(과거 mutedUntil) 행은 활성 뮤트가 아니므로 제외하지 않는다(cron sweep
 * 없이 query-time 필터 — S46/S43 규약).
 *
 * ── 읽지 않음/멘션 집계 ──
 * UnreadService 의 (createdAt, id) 튜플 커서 공식 + roots-only(parentMessageId IS
 * NULL OR isBroadcast) 술어를 그대로 따른다(채널 배지 정본과 정합).
 *
 * ── ACL 가시성 = canonical 5-step fold (S47 fix-forward · BLOCKER-4) ──
 * 종전엔 비공개 가시성이 `(bit_or(allow) & ~bit_or(deny)) & 1`(USER/ROLE 혼합)인
 * 2-step union 이라, UnreadService.readBitVisibleSql 의 5단계 fold(user DENY > role
 * ALLOW 등 경계)와 어긋나 private 채널을 과대/과소 카운트했다. 이제 rail/ACK 와
 * **동일한 공유 헬퍼(`common/acl/read-visibility.sql`)** 의 5단계 fold + mentionMatch
 * 를 재사용해 단일 truth-source 를 보장한다. OWNER short-circuit 도 UnreadService 와
 * 정합하게 fold 통과(OWNER baseline READ + 명시 DENY 존중). 멘션은 직접 @username +
 * everyone/here/channel containment(GIN 인덱스 활용)를 본다.
 */
export interface NotificationBadge {
  workspaceId: string;
  mentionCount: number;
  unreadCount: number;
}

@Injectable()
export class MeNotificationBadgesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 가입한 모든 워크스페이스의 배지를 반환한다(카운트 0 인 워크스페이스도 한 줄 —
   * 클라가 cross-join 없이 전체 교체할 수 있도록). 서버 뮤트인 워크스페이스도 한 줄
   * (둘 다 0)로 유지한다.
   *
   * @param now mute 활성 판정 기준 시각(테스트 결정성 — vi.setSystemTime 정합).
   */
  async badges(userId: string, now: Date = new Date()): Promise<NotificationBadge[]> {
    return this.aggregate(userId, null, now);
  }

  /**
   * 단일 워크스페이스 배지(WS `notification:badge_update` emit 용 — 멘션 발생 시
   * 그 워크스페이스만 재집계). 뮤트 게이트는 badges 와 동일하게 적용된다.
   *
   * S47 fix-forward (BLOCKER-5 · perf): 종전엔 `badges()`(전 워크스페이스 집계)를
   * 돌린 뒤 `.find()` 로 한 줄만 골라, 멘션마다·@everyone N 명마다 전체 워크스페이스
   * 를 재집계했다(N×(6CTE+LATERAL) — P95 SLO 위협). 이제 `my_memberships`/
   * `visible_channels` CTE 최상단에서 workspaceId 로 필터한 단일-ws 경로(aggregate
   * 가 wsId 를 받아 CTE 에 박는다)로 emit 비용을 1ws 집계로 낮춘다.
   */
  async badgeFor(
    userId: string,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<NotificationBadge> {
    const rows = await this.aggregate(userId, workspaceId, now);
    return rows[0] ?? { workspaceId, mentionCount: 0, unreadCount: 0 };
  }

  /**
   * S47 fix-forward (BLOCKER-4/5): 배지 집계 단일 출처. `workspaceId` 가 주어지면
   * 그 워크스페이스만 집계하고(badgeFor — 단일-ws emit), null 이면 가입한 전 워크
   * 스페이스를 집계한다(badges — 전체 재동기화). ACL 가시성은 rail/ACK 와 동일한
   * 공유 헬퍼의 5단계 fold(readBitVisibleSql) + 멘션 판정(mentionMatchSql)을 쓴다.
   */
  private async aggregate(
    userId: string,
    workspaceId: string | null,
    now: Date,
  ): Promise<NotificationBadge[]> {
    // workspaceId 필터를 CTE 최상단에 박는다(null 이면 무필터 — 전 워크스페이스).
    const wsFilter = workspaceId
      ? Prisma.sql`AND wm."workspaceId" = ${workspaceId}::uuid`
      : Prisma.empty;
    // 비공개 가시성 5단계 fold — overrides CTE 의 principalType 별 bit_or 컬럼을 참조.
    const visible = readBitVisibleSql({
      isPrivate: Prisma.sql`vc2."isPrivate"`,
      roleAllow: Prisma.sql`vc2.role_allow`,
      roleDeny: Prisma.sql`vc2.role_deny`,
      userAllow: Prisma.sql`vc2.user_allow`,
      userDeny: Prisma.sql`vc2.user_deny`,
    });
    const mentionMatch = mentionMatchSql(Prisma.sql`msg`, Prisma.sql`${userId}::text`);

    const rows = await this.prisma.$queryRaw<
      Array<{
        workspace_id: string;
        mention_count: bigint | number;
        unread_count: bigint | number;
      }>
    >(Prisma.sql`
      WITH my_memberships AS (
        SELECT wm."workspaceId", wm.role
          FROM "WorkspaceMember" wm
         WHERE wm."userId" = ${userId}::uuid
           ${wsFilter}
      ),
      -- 서버(워크스페이스) 뮤트: 활성이면 그 워크스페이스 전체를 카운트 0 으로 만든다.
      muted_servers AS (
        SELECT snp."workspaceId"
          FROM "ServerNotificationPref" snp
         WHERE snp."userId" = ${userId}::uuid
           AND snp."isMuted" = true
           AND (snp."muteUntil" IS NULL OR snp."muteUntil" > ${now}::timestamptz)
      ),
      -- 채널 뮤트: 활성이면 그 채널만 합산에서 제외한다.
      muted_channels AS (
        SELECT ucm."channelId"
          FROM "UserChannelMute" ucm
         WHERE ucm."userId" = ${userId}::uuid
           AND ucm."isMuted" = true
           AND (ucm."mutedUntil" IS NULL OR ucm."mutedUntil" > ${now}::timestamptz)
      ),
      -- 본인 적용 오버라이드(USER 본인 | ROLE 본인역할)를 채널별로 bit_or.
      -- readBitVisibleSql 5단계 fold 가 이 컬럼들을 참조한다(rail 과 동일 패턴).
      overrides AS (
        SELECT
          cpo."channelId",
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_deny,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_deny
        FROM "ChannelPermissionOverride" cpo
        JOIN "Channel" cc ON cc.id = cpo."channelId"
        JOIN my_memberships mm ON mm."workspaceId" = cc."workspaceId"
        WHERE (
          (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
          OR (cpo."principalType" = 'ROLE' AND ${roleOverridePrincipalMatchSql({
            principalId: Prisma.sql`cpo."principalId"`,
            roleLiteral: Prisma.sql`mm.role::text`,
            userParam: Prisma.sql`${userId}::uuid`,
            workspaceMatch: Prisma.sql`AND mr."workspaceId" = cc."workspaceId"`,
          })})
        )
        GROUP BY cpo."channelId"
      ),
      -- 본인이 가시한(비뮤트) 채널 집합. 비공개 채널 가시성은 5단계 fold(rail/ACK 정합).
      visible_channels AS (
        SELECT vc2.channel_id, vc2."workspaceId"
          FROM (
            SELECT c.id AS channel_id, c."workspaceId", c."isPrivate", mm.role,
                   o.role_allow, o.role_deny, o.user_allow, o.user_deny
              FROM "Channel" c
              JOIN my_memberships mm ON mm."workspaceId" = c."workspaceId"
              LEFT JOIN overrides o ON o."channelId" = c.id
             WHERE c."deletedAt" IS NULL
               AND c."workspaceId" NOT IN (SELECT "workspaceId" FROM muted_servers)
               AND c.id NOT IN (SELECT "channelId" FROM muted_channels)
          ) vc2
         WHERE ${visible}
      ),
      per_channel AS (
        SELECT
          vc."workspaceId",
          COALESCE(m.unread_count, 0)  AS unread_count,
          COALESCE(m.mention_count, 0) AS mention_count
        FROM visible_channels vc
        LEFT JOIN "UserChannelReadState" rs
          ON rs."userId" = ${userId}::uuid
         AND rs."channelId" = vc.channel_id
        LEFT JOIN LATERAL (
          SELECT
            count(*) AS unread_count,
            count(*) FILTER (WHERE ${mentionMatch}) AS mention_count
          FROM "Message" msg
          WHERE msg."channelId" = vc.channel_id
            AND msg."deletedAt" IS NULL
            AND msg."authorId" <> ${userId}::uuid
            -- roots-only(채널 배지 정본과 정합 — 스레드 답글은 채널 배지 미산입).
            AND (msg."parentMessageId" IS NULL OR msg."isBroadcast" = true)
            AND (
              rs."lastReadMessageCreatedAt" IS NULL
              OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
            )
        ) m ON true
      )
      SELECT
        mm."workspaceId"                       AS workspace_id,
        COALESCE(SUM(pc.mention_count), 0)     AS mention_count,
        COALESCE(SUM(pc.unread_count), 0)      AS unread_count
      FROM my_memberships mm
      LEFT JOIN per_channel pc ON pc."workspaceId" = mm."workspaceId"
      GROUP BY mm."workspaceId"
      ORDER BY mm."workspaceId" ASC
    `);

    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      mentionCount: Number(r.mention_count ?? 0),
      unreadCount: Number(r.unread_count ?? 0),
    }));
  }
}
