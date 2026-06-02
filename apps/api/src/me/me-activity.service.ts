import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * task-026-B: Activity inbox UNION query over three sources:
 *   1. messages mentioning the caller (mention)
 *   2. messages replying to a root the caller authored (reply)
 *   3. reactions on messages the caller authored (reaction)
 *
 * Each row is tagged with `kind` + `activityKey` so the client can
 * pin read-state via POST /me/activity/:activityKey/read. ACL filter
 * mirrors me-mentions (public channels pass, OWNER sees all, else
 * ChannelPermissionOverride mask bit must be set).
 */
export type ActivityKind = 'mention' | 'reply' | 'reaction' | 'direct' | 'friend_request';

export interface ActivityRow {
  activityKey: string;
  kind: ActivityKind;
  workspaceId: string;
  channelId: string;
  messageId: string;
  actorId: string;
  /**
   * S47 fix-forward (a11y A-2): read-time User.username join. 접근명/표시명용 —
   * actorId.slice 대신 사람이 읽을 수 있는 이름. join 누락(삭제 사용자 등)이면 null.
   * 마이그레이션 아님(질의 시점 join).
   */
  actorName: string | null;
  snippet: string;
  createdAt: string;
  readAt: string | null;
  extra?: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityRow[];
  nextCursor: string | null;
}

export interface UnreadCounts {
  total: number;
  mentions: number;
  replies: number;
  reactions: number;
  directs: number;
  friendRequests: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
/** S47 fix-forward (BLOCKER-6): activityKey suffix 가 UUID 인지 가드(SQL 캐스트 보호). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MeActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    userId: string,
    filter: 'all' | 'mentions' | 'replies' | 'reactions' | 'directs' | 'friend_requests',
    cursor: string | null,
    limit: number,
  ): Promise<ActivityPage> {
    const capped = Math.max(1, Math.min(MAX_LIMIT, limit || DEFAULT_LIMIT));
    // cursor = "<isoCreatedAt>|<activityKey>" (urlsafe already).
    let cursorTs: Date | null = null;
    let cursorKey: string | null = null;
    if (cursor) {
      const [ts, key] = cursor.split('|');
      if (ts && key) {
        // S47 fix-forward (BLOCKER-6 · security): Invalid Date 검증. 위조/깨진
        // cursor 의 `new Date(ts)` 가 Invalid Date 이면 timestamptz 캐스트가
        // 런타임에 터지거나 비결정 동작을 하므로 400 으로 거른다.
        const parsed = new Date(ts);
        if (Number.isNaN(parsed.getTime())) {
          throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid activity cursor');
        }
        cursorTs = parsed;
        cursorKey = key;
      }
    }

    const includeMention = filter === 'all' || filter === 'mentions';
    const includeReply = filter === 'all' || filter === 'replies';
    const includeReaction = filter === 'all' || filter === 'reactions';
    const includeDirect = filter === 'all' || filter === 'directs';
    const includeFriendRequest = filter === 'all' || filter === 'friend_requests';

    const rows = await this.prisma.$queryRaw<
      Array<{
        activityKey: string;
        kind: ActivityKind;
        workspaceId: string;
        channelId: string;
        messageId: string;
        actorId: string;
        actorName: string | null;
        snippet: string;
        createdAt: Date;
        readAt: Date | null;
      }>
    >`
      WITH acc AS (
        SELECT c.id AS "channelId",
               c."workspaceId",
               c."isPrivate",
               wm.role,
               COALESCE(
                 (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                    FROM "ChannelPermissionOverride" cpo
                   WHERE cpo."channelId" = c.id
                     AND (
                       (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                       OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                     )),
                 0
               ) AS overrideBit
          FROM "Channel" c
          JOIN "WorkspaceMember" wm
            ON wm."workspaceId" = c."workspaceId"
           AND wm."userId" = ${userId}::uuid
         WHERE c."deletedAt" IS NULL
           -- S47 fix-forward (BLOCKER-3 · security): OR TRUE 제거. 종전엔 acc CTE
           -- 가 모든 채널(비가시 private 포함)을 통과시키고 하위 CTE 의 overrideBit
           -- 재필터에만 의존했는데, acc 가 overrideBit 를 함께 들고 있으므로 acc 단계
           -- 에서 가시성을 거는 게 정합한다(private 채널은 OWNER 거나 READ 비트 ALLOW).
           AND (c."isPrivate" = false OR wm.role = 'OWNER' OR (
             COALESCE(
               (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                  FROM "ChannelPermissionOverride" cpo
                 WHERE cpo."channelId" = c.id
                   AND (
                     (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                     OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                   )),
               0
             ) > 0
           ))
      ),
      mentions AS (
        SELECT
          ('mention:' || m.id::text) AS "activityKey",
          'mention'::text            AS "kind",
          acc."workspaceId",
          m."channelId",
          m.id                       AS "messageId",
          m."authorId"               AS "actorId",
          au.username                AS "actorName",
          LEFT(m."contentPlain", 140) AS "snippet",
          m."createdAt"
        FROM "Message" m
        JOIN acc ON acc."channelId" = m."channelId"
        LEFT JOIN "User" au ON au.id = m."authorId"
        WHERE ${includeMention}
          AND m."deletedAt" IS NULL
          AND m."authorId" <> ${userId}::uuid
          AND (
            m.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
            OR (m.mentions->>'everyone')::boolean IS TRUE
          )
          AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      replies AS (
        SELECT
          ('reply:' || m.id::text) AS "activityKey",
          'reply'::text            AS "kind",
          acc."workspaceId",
          m."channelId",
          m.id                     AS "messageId",
          m."authorId"             AS "actorId",
          au.username              AS "actorName",
          LEFT(m."contentPlain", 140) AS "snippet",
          m."createdAt"
        FROM "Message" m
        JOIN "Message" root
          ON root.id = m."parentMessageId"
         AND root."authorId" = ${userId}::uuid
         AND root."deletedAt" IS NULL
        JOIN acc ON acc."channelId" = m."channelId"
        LEFT JOIN "User" au ON au.id = m."authorId"
        WHERE ${includeReply}
          AND m."deletedAt" IS NULL
          -- S35 fix-forward: broadcast 행(isBroadcast=true)도 parentMessageId =
          -- 루트를 갖지만 답글이 아니라 채널 타임라인 사본이다. 가드가 없으면
          -- 'Also send to #channel' 게시가 루트 작성자의 활동 피드에 phantom
          -- 답글 활동으로 잡힌다. broadcast 는 제외한다(원본 답글이 이미 집계됨).
          AND m."isBroadcast" = false
          AND m."authorId" <> ${userId}::uuid
          AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      reactions AS (
        SELECT
          ('reaction:' || mr.id::text) AS "activityKey",
          'reaction'::text             AS "kind",
          acc."workspaceId",
          m."channelId",
          m.id                         AS "messageId",
          mr."userId"                  AS "actorId",
          ru.username                  AS "actorName",
          COALESCE(mr.emoji, '')       AS "snippet",
          mr."createdAt"
        FROM "MessageReaction" mr
        JOIN "Message" m ON m.id = mr."messageId" AND m."deletedAt" IS NULL
        JOIN acc ON acc."channelId" = m."channelId"
        LEFT JOIN "User" ru ON ru.id = mr."userId"
        WHERE ${includeReaction}
          AND m."authorId" = ${userId}::uuid
          AND mr."userId" <> ${userId}::uuid
          AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      directs AS (
        SELECT
          ('direct:' || m.id::text) AS "activityKey",
          'direct'::text            AS "kind",
          c."workspaceId",
          m."channelId",
          m.id                      AS "messageId",
          m."authorId"              AS "actorId",
          du.username               AS "actorName",
          LEFT(m."contentPlain", 140) AS "snippet",
          m."createdAt"
        FROM "Message" m
        JOIN "Channel" c ON c.id = m."channelId" AND c.type = 'DIRECT' AND c."deletedAt" IS NULL
        JOIN "ChannelPermissionOverride" mine
          ON mine."channelId" = c.id
         AND mine."principalType" = 'USER'
         AND mine."principalId" = ${userId}::text
         AND (mine."allowMask" & 1) > 0
        LEFT JOIN "User" du ON du.id = m."authorId"
        WHERE ${includeDirect}
          AND m."deletedAt" IS NULL
          AND m."authorId" <> ${userId}::uuid
      ),
      friend_requests AS (
        SELECT
          ('friend_request:' || f.id::text) AS "activityKey",
          'friend_request'::text            AS "kind",
          NULL::uuid                        AS "workspaceId",
          NULL::uuid                        AS "channelId",
          f.id                              AS "messageId",
          f."requesterId"                   AS "actorId",
          u.username                        AS "actorName",
          u.username                        AS "snippet",
          f."createdAt"
        FROM "Friendship" f
        JOIN "User" u ON u.id = f."requesterId"
        WHERE ${includeFriendRequest}
          AND f."addresseeId" = ${userId}::uuid
          AND f.status = 'PENDING'
      ),
      combined AS (
        SELECT * FROM mentions
        UNION ALL
        SELECT * FROM replies
        UNION ALL
        SELECT * FROM reactions
        UNION ALL
        SELECT * FROM directs
        UNION ALL
        SELECT * FROM friend_requests
      )
      SELECT
        combined.*,
        rs."readAt"
      FROM combined
      LEFT JOIN "UserActivityReadState" rs
        ON rs."userId" = ${userId}::uuid
       AND rs."activityKey" = combined."activityKey"
      WHERE (
        ${cursorTs}::timestamptz IS NULL
        OR combined."createdAt" < ${cursorTs}::timestamptz
        OR (combined."createdAt" = ${cursorTs}::timestamptz AND combined."activityKey" < ${cursorKey}::text)
      )
      ORDER BY combined."createdAt" DESC, combined."activityKey" DESC
      LIMIT ${capped + 1}
    `;

    const hasMore = rows.length > capped;
    const items = (hasMore ? rows.slice(0, capped) : rows).map((r) => ({
      activityKey: r.activityKey,
      kind: r.kind,
      workspaceId: r.workspaceId,
      channelId: r.channelId,
      messageId: r.messageId,
      actorId: r.actorId,
      actorName: r.actorName ?? null,
      snippet: r.snippet,
      createdAt: r.createdAt.toISOString(),
      readAt: r.readAt ? r.readAt.toISOString() : null,
    }));
    const nextCursor = hasMore
      ? `${items[items.length - 1].createdAt}|${items[items.length - 1].activityKey}`
      : null;
    return { items, nextCursor };
  }

  async unreadCounts(userId: string): Promise<UnreadCounts> {
    const rows = await this.prisma.$queryRaw<Array<{ kind: ActivityKind; cnt: bigint }>>`
      WITH acc AS (
        SELECT c.id AS "channelId", c."workspaceId", c."isPrivate", wm.role,
               COALESCE(
                 (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                    FROM "ChannelPermissionOverride" cpo
                   WHERE cpo."channelId" = c.id
                     AND (
                       (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                       OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                     )),
                 0
               ) AS overrideBit
          FROM "Channel" c
          JOIN "WorkspaceMember" wm
            ON wm."workspaceId" = c."workspaceId"
           AND wm."userId" = ${userId}::uuid
         WHERE c."deletedAt" IS NULL
      ),
      unread_mentions AS (
        SELECT 'mention'::text AS kind, ('mention:' || m.id::text) AS k
          FROM "Message" m
          JOIN acc ON acc."channelId" = m."channelId"
         WHERE m."deletedAt" IS NULL
           AND m."authorId" <> ${userId}::uuid
           AND (
             m.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
             OR (m.mentions->>'everyone')::boolean IS TRUE
           )
           AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      unread_replies AS (
        SELECT 'reply'::text AS kind, ('reply:' || m.id::text) AS k
          FROM "Message" m
          JOIN "Message" root
            ON root.id = m."parentMessageId"
           AND root."authorId" = ${userId}::uuid
           AND root."deletedAt" IS NULL
          JOIN acc ON acc."channelId" = m."channelId"
         WHERE m."deletedAt" IS NULL
           -- S35 fix-forward: broadcast 행은 답글이 아니므로 미읽 reply 카운트에서
           -- 제외한다(활동 피드 replies CTE 와 동일 가드).
           AND m."isBroadcast" = false
           AND m."authorId" <> ${userId}::uuid
           AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      unread_reactions AS (
        SELECT 'reaction'::text AS kind, ('reaction:' || mr.id::text) AS k
          FROM "MessageReaction" mr
          JOIN "Message" m ON m.id = mr."messageId" AND m."deletedAt" IS NULL
          JOIN acc ON acc."channelId" = m."channelId"
         WHERE m."authorId" = ${userId}::uuid
           AND mr."userId" <> ${userId}::uuid
           AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      unread_directs AS (
        SELECT 'direct'::text AS kind, ('direct:' || m.id::text) AS k
          FROM "Message" m
          JOIN "Channel" c ON c.id = m."channelId" AND c.type = 'DIRECT' AND c."deletedAt" IS NULL
          JOIN "ChannelPermissionOverride" mine
            ON mine."channelId" = c.id
           AND mine."principalType" = 'USER'
           AND mine."principalId" = ${userId}::text
           AND (mine."allowMask" & 1) > 0
         WHERE m."deletedAt" IS NULL
           AND m."authorId" <> ${userId}::uuid
      ),
      unread_friend_requests AS (
        SELECT 'friend_request'::text AS kind, ('friend_request:' || f.id::text) AS k
          FROM "Friendship" f
         WHERE f."addresseeId" = ${userId}::uuid
           AND f.status = 'PENDING'
      ),
      combined AS (
        SELECT * FROM unread_mentions
        UNION ALL
        SELECT * FROM unread_replies
        UNION ALL
        SELECT * FROM unread_reactions
        UNION ALL
        SELECT * FROM unread_directs
        UNION ALL
        SELECT * FROM unread_friend_requests
      )
      SELECT combined.kind, COUNT(*)::bigint AS cnt
        FROM combined
        LEFT JOIN "UserActivityReadState" rs
          ON rs."userId" = ${userId}::uuid
         AND rs."activityKey" = combined.k
       WHERE rs."id" IS NULL
       GROUP BY combined.kind
    `;

    const counts: UnreadCounts = {
      total: 0,
      mentions: 0,
      replies: 0,
      reactions: 0,
      directs: 0,
      friendRequests: 0,
    };
    for (const r of rows) {
      const n = Number(r.cnt);
      if (r.kind === 'mention') counts.mentions = n;
      if (r.kind === 'reply') counts.replies = n;
      if (r.kind === 'reaction') counts.reactions = n;
      if (r.kind === 'direct') counts.directs = n;
      if (r.kind === 'friend_request') counts.friendRequests = n;
      counts.total += n;
    }
    return counts;
  }

  /**
   * S47 fix-forward (BLOCKER-6 · security IDOR): activityKey 의 실제 수신자가
   * `userId` 인지 검증한 뒤에만 read-state 를 upsert 한다. 종전엔 소유권 검증 없이
   * 임의 activityKey 를 upsert 해, 타인의 activity 를 강제로 "읽음" 표시할 수 있었다
   * (UserActivityReadState 행이 userId 로 격리돼 타인 카운트를 직접 바꾸진 못하지만,
   * 존재하지 않거나 수신 대상이 아닌 키로 read row 를 만드는 건 의미가 없고, 키
   * enumeration 으로 다른 사용자의 메시지/반응 존재 여부를 probe 하는 표면을 연다).
   * prefix(`<kind>:<id>`) 를 파싱해 수신자가 userId 인지 확인하고, 불일치/미존재면
   * FORBIDDEN(403). 가시성 판정은 page() 의 acc CTE 와 동일 술어(public OR OWNER OR
   * READ-bit ALLOW)를 따른다.
   */
  async markRead(userId: string, activityKey: string): Promise<void> {
    const sep = activityKey.indexOf(':');
    if (sep <= 0) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'malformed activityKey');
    }
    const kind = activityKey.slice(0, sep) as ActivityKind;
    const id = activityKey.slice(sep + 1);
    if (!id) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'malformed activityKey');
    }

    const owns = await this.activityKeyBelongsTo(userId, kind, id);
    if (!owns) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'activity does not belong to caller');
    }

    await this.prisma.userActivityReadState.upsert({
      where: { userId_activityKey: { userId, activityKey } },
      create: { userId, activityKey },
      update: { readAt: new Date() },
    });
  }

  /**
   * S47 fix-forward (BLOCKER-6): activityKey 의 수신자 검증(kind 별 1 쿼리). page()
   * 의 각 CTE 가 정의하는 "수신 대상" 술어를 그대로 점검한다:
   *   mention   — 그 메시지가 userId 를 멘션(직접/everyone)하고 userId 가 채널 가시.
   *   reply     — 그 메시지의 root(parentMessageId)의 authorId == userId 이고 채널 가시.
   *   reaction  — 반응이 달린 메시지의 authorId == userId 이고 채널 가시.
   *   direct    — 그 메시지가 속한 DIRECT 채널에 userId 가 READ-allow 오버라이드 보유.
   *   friend_request — Friendship.addresseeId == userId AND status PENDING.
   * 가시성(채널)은 acc 술어(public OR OWNER OR (allow&~deny&1)>0)와 동일하게 본다.
   */
  private async activityKeyBelongsTo(
    userId: string,
    kind: ActivityKind,
    id: string,
  ): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;

    if (kind === 'friend_request') {
      const fr = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT TRUE AS ok
          FROM "Friendship" f
         WHERE f.id = ${id}::uuid
           AND f."addresseeId" = ${userId}::uuid
           AND f.status = 'PENDING'
         LIMIT 1
      `;
      return fr.length > 0;
    }

    if (kind === 'direct') {
      const dm = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT TRUE AS ok
          FROM "Message" m
          JOIN "Channel" c ON c.id = m."channelId" AND c.type = 'DIRECT' AND c."deletedAt" IS NULL
          JOIN "ChannelPermissionOverride" mine
            ON mine."channelId" = c.id
           AND mine."principalType" = 'USER'
           AND mine."principalId" = ${userId}::text
           AND (mine."allowMask" & 1) > 0
         WHERE m.id = ${id}::uuid
           AND m."deletedAt" IS NULL
           AND m."authorId" <> ${userId}::uuid
         LIMIT 1
      `;
      return dm.length > 0;
    }

    if (kind === 'reaction') {
      const re = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
        WITH visible AS (
          SELECT c.id AS channel_id
            FROM "Channel" c
            JOIN "WorkspaceMember" wm
              ON wm."workspaceId" = c."workspaceId" AND wm."userId" = ${userId}::uuid
           WHERE c."deletedAt" IS NULL
             AND (c."isPrivate" = false OR wm.role = 'OWNER' OR (
               COALESCE(
                 (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                    FROM "ChannelPermissionOverride" cpo
                   WHERE cpo."channelId" = c.id
                     AND (
                       (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                       OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                     )),
                 0
               ) > 0
             ))
        )
        SELECT TRUE AS ok
          FROM "MessageReaction" mr
          JOIN "Message" m ON m.id = mr."messageId" AND m."deletedAt" IS NULL
          JOIN visible v ON v.channel_id = m."channelId"
         WHERE mr.id = ${id}::uuid
           AND m."authorId" = ${userId}::uuid
           AND mr."userId" <> ${userId}::uuid
         LIMIT 1
      `;
      return re.length > 0;
    }

    // mention / reply 는 메시지 id 기준. 채널 가시성 + 수신 대상 술어를 함께 본다.
    const isMention = kind === 'mention';
    const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
      WITH visible AS (
        SELECT c.id AS channel_id, wm.role
          FROM "Channel" c
          JOIN "WorkspaceMember" wm
            ON wm."workspaceId" = c."workspaceId" AND wm."userId" = ${userId}::uuid
         WHERE c."deletedAt" IS NULL
           AND (c."isPrivate" = false OR wm.role = 'OWNER' OR (
             COALESCE(
               (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                  FROM "ChannelPermissionOverride" cpo
                 WHERE cpo."channelId" = c.id
                   AND (
                     (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                     OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                   )),
               0
             ) > 0
           ))
      )
      SELECT TRUE AS ok
        FROM "Message" m
        JOIN visible v ON v.channel_id = m."channelId"
        LEFT JOIN "Message" root
          ON root.id = m."parentMessageId" AND root."deletedAt" IS NULL
       WHERE m.id = ${id}::uuid
         AND m."deletedAt" IS NULL
         AND m."authorId" <> ${userId}::uuid
         AND (
           (${isMention} AND (
             m.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
             OR (m.mentions->>'everyone')::boolean IS TRUE
           ))
           OR (NOT ${isMention} AND m."isBroadcast" = false AND root."authorId" = ${userId}::uuid)
         )
       LIMIT 1
    `;
    return rows.length > 0;
  }

  async markAllRead(
    userId: string,
    filter: 'all' | 'mentions' | 'replies' | 'reactions' | 'directs' | 'friend_requests',
  ): Promise<{ count: number }> {
    // Load the unread activityKeys for the filter, upsert each. Bulk
    // upsert via executeRaw keeps us under the round-trip cost.
    const page = await this.page(userId, filter, null, MAX_LIMIT);
    const keys = page.items.filter((i) => !i.readAt).map((i) => i.activityKey);
    if (keys.length === 0) return { count: 0 };
    await this.prisma.$transaction(
      keys.map((k) =>
        this.prisma.userActivityReadState.upsert({
          where: { userId_activityKey: { userId, activityKey: k } },
          create: { userId, activityKey: k },
          update: { readAt: new Date() },
        }),
      ),
    );
    return { count: keys.length };
  }
}
