import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

/**
 * S47 (D06 / FR-MN-14 / FR-MN-20): 서버(워크스페이스) 단위 알림 배지 집계.
 *
 * `GET /me/notification-badges` 와 WS `notification:badge_update` 가 공유하는 단일
 * 출처다. 워크스페이스별 `{ mentionCount, unreadCount }` 를 반환하되, **isMuted
 * 채널/서버는 카운트에서 제외**한다(FR-MN-14: "isMuted=true 채널·서버는 배지 완전
 * 숨김 — 카운트 증가 자체 건너뜀"). `/me/unread-totals`(UnreadService.cachedWorkspaceTotal)
 * 와 역할이 다르다 — 그쪽은 사이드바 레일의 *미읽* 집계(뮤트 무관)이고, 본 서비스는
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
 * ── 미읽/멘션 집계 ──
 * UnreadService 의 (createdAt, id) 튜플 커서 공식 + roots-only(parentMessageId IS
 * NULL OR isBroadcast) 술어를 그대로 따른다(채널 배지 정본과 정합). ACL 가시성은
 * 비공개 채널에 한해 `(allow & ~deny) & READ_BIT > 0` 단순 판정을 적용한다
 * (me-mentions/me-activity 와 동일 패턴 — 본 배지는 알림 도달 가능성 기준이라
 * UnreadService 의 5단계 fold 보다 보수적으로 충분하다). 멘션은 직접 @username +
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
      -- 본인이 가시한(비뮤트) 채널 집합. 비공개 채널은 OWNER 거나 READ 비트 ALLOW.
      visible_channels AS (
        SELECT c.id AS channel_id, c."workspaceId"
          FROM "Channel" c
          JOIN my_memberships mm ON mm."workspaceId" = c."workspaceId"
         WHERE c."deletedAt" IS NULL
           AND c."workspaceId" NOT IN (SELECT "workspaceId" FROM muted_servers)
           AND c.id NOT IN (SELECT "channelId" FROM muted_channels)
           AND (
             c."isPrivate" = false
             OR mm.role = 'OWNER'
             OR COALESCE(
                  (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                     FROM "ChannelPermissionOverride" cpo
                    WHERE cpo."channelId" = c.id
                      AND (
                        (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                        OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = mm.role::text)
                      )),
                  0
                ) > 0
           )
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
            count(*) FILTER (
              WHERE (
                msg.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
                OR msg.mentions @> '{"everyone":true}'::jsonb
                OR msg.mentions @> '{"here":true}'::jsonb
                OR msg.mentions @> '{"channel":true}'::jsonb
              )
            ) AS mention_count
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

  /**
   * 단일 워크스페이스 배지(WS `notification:badge_update` emit 용 — 멘션 발생 시
   * 그 워크스페이스만 재집계). 뮤트 게이트는 badges 와 동일하게 적용된다.
   */
  async badgeFor(
    userId: string,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<NotificationBadge> {
    const all = await this.badges(userId, now);
    const found = all.find((b) => b.workspaceId === workspaceId);
    return found ?? { workspaceId, mentionCount: 0, unreadCount: 0 };
  }
}
