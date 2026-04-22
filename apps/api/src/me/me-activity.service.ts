import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';

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
export type ActivityKind = 'mention' | 'reply' | 'reaction';

export interface ActivityRow {
  activityKey: string;
  kind: ActivityKind;
  workspaceId: string;
  channelId: string;
  messageId: string;
  actorId: string;
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
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

@Injectable()
export class MeActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    userId: string,
    filter: 'all' | 'mentions' | 'replies' | 'reactions',
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
        cursorTs = new Date(ts);
        cursorKey = key;
      }
    }

    const includeMention = filter === 'all' || filter === 'mentions';
    const includeReply = filter === 'all' || filter === 'replies';
    const includeReaction = filter === 'all' || filter === 'reactions';

    const rows = await this.prisma.$queryRaw<
      Array<{
        activityKey: string;
        kind: ActivityKind;
        workspaceId: string;
        channelId: string;
        messageId: string;
        actorId: string;
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
           AND (c."isPrivate" = false OR wm.role = 'OWNER' OR TRUE)
      ),
      mentions AS (
        SELECT
          ('mention:' || m.id::text) AS "activityKey",
          'mention'::text            AS "kind",
          acc."workspaceId",
          m."channelId",
          m.id                       AS "messageId",
          m."authorId"               AS "actorId",
          LEFT(m."contentPlain", 140) AS "snippet",
          m."createdAt"
        FROM "Message" m
        JOIN acc ON acc."channelId" = m."channelId"
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
          LEFT(m."contentPlain", 140) AS "snippet",
          m."createdAt"
        FROM "Message" m
        JOIN "Message" root
          ON root.id = m."parentMessageId"
         AND root."authorId" = ${userId}::uuid
         AND root."deletedAt" IS NULL
        JOIN acc ON acc."channelId" = m."channelId"
        WHERE ${includeReply}
          AND m."deletedAt" IS NULL
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
          COALESCE(mr.emoji, '')       AS "snippet",
          mr."createdAt"
        FROM "MessageReaction" mr
        JOIN "Message" m ON m.id = mr."messageId" AND m."deletedAt" IS NULL
        JOIN acc ON acc."channelId" = m."channelId"
        WHERE ${includeReaction}
          AND m."authorId" = ${userId}::uuid
          AND mr."userId" <> ${userId}::uuid
          AND (acc."isPrivate" = false OR acc.role = 'OWNER' OR acc.overrideBit > 0)
      ),
      combined AS (
        SELECT * FROM mentions
        UNION ALL
        SELECT * FROM replies
        UNION ALL
        SELECT * FROM reactions
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
      combined AS (
        SELECT * FROM unread_mentions
        UNION ALL
        SELECT * FROM unread_replies
        UNION ALL
        SELECT * FROM unread_reactions
      )
      SELECT combined.kind, COUNT(*)::bigint AS cnt
        FROM combined
        LEFT JOIN "UserActivityReadState" rs
          ON rs."userId" = ${userId}::uuid
         AND rs."activityKey" = combined.k
       WHERE rs."id" IS NULL
       GROUP BY combined.kind
    `;

    const counts: UnreadCounts = { total: 0, mentions: 0, replies: 0, reactions: 0 };
    for (const r of rows) {
      const n = Number(r.cnt);
      if (r.kind === 'mention') counts.mentions = n;
      if (r.kind === 'reply') counts.replies = n;
      if (r.kind === 'reaction') counts.reactions = n;
      counts.total += n;
    }
    return counts;
  }

  async markRead(userId: string, activityKey: string): Promise<void> {
    await this.prisma.userActivityReadState.upsert({
      where: { userId_activityKey: { userId, activityKey } },
      create: { userId, activityKey },
      update: { readAt: new Date() },
    });
  }

  async markAllRead(
    userId: string,
    filter: 'all' | 'mentions' | 'replies' | 'reactions',
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
