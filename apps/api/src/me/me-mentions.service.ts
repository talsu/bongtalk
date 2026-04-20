import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';

export interface MentionSummary {
  messageId: string;
  channelId: string;
  workspaceId: string;
  authorId: string;
  snippet: string;
  createdAt: string;
  everyone: boolean;
}

/**
 * Task-011-B: inbox view of mentions for the caller. Uses jsonb
 * containment via the GIN index added in the 20260420 migration.
 *
 * `unreadCount` is the count of mentions where `createdAt >
 * lastReadAt`. We model "read" as having scrolled down into the
 * channel — reusing `UserChannelReadState.lastReadAt` so a user who
 * reads #general clears its mentions at the same time. This keeps
 * state minimal (no separate mention-read table) and matches the
 * Discord "visiting the channel acknowledges its mentions" UX.
 */
@Injectable()
export class MeMentionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Paginated recent mentions (newest first). `limit` capped to 50.
   * Returns `recent[]` only; caller composes `unreadCount` from the
   * separate summary call — keeps this endpoint paginatable without
   * mixing aggregate + list semantics.
   */
  async recent(userId: string, limit = 20): Promise<MentionSummary[]> {
    const capped = Math.max(1, Math.min(50, limit));
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        channelId: string;
        workspaceId: string;
        authorId: string;
        snippet: string;
        createdAt: Date;
        everyone: boolean;
      }>
    >`
      SELECT
        m.id          AS "id",
        m."channelId" AS "channelId",
        c."workspaceId" AS "workspaceId",
        m."authorId"  AS "authorId",
        LEFT(m."contentPlain", 140) AS snippet,
        m."createdAt" AS "createdAt",
        (m.mentions->>'everyone')::boolean AS "everyone"
      FROM "Message" m
      JOIN "Channel" c ON c.id = m."channelId"
      -- task-011 reviewer MED-3 fix: kicked members should NOT see
      -- retained mentions from the workspace they no longer belong to.
      -- Existing @@unique([workspaceId, userId]) index makes this join
      -- a single lookup per member row.
      JOIN "WorkspaceMember" wm
        ON wm."workspaceId" = c."workspaceId"
       AND wm."userId" = ${userId}::uuid
      WHERE m."deletedAt" IS NULL
        AND m."authorId" <> ${userId}::uuid
        AND (
          m.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
          OR (m.mentions->>'everyone')::boolean IS TRUE
        )
      ORDER BY m."createdAt" DESC
      LIMIT ${capped}
    `;
    return rows.map((r) => ({
      messageId: r.id,
      channelId: r.channelId,
      workspaceId: r.workspaceId,
      authorId: r.authorId,
      snippet: r.snippet,
      createdAt: r.createdAt.toISOString(),
      everyone: r.everyone === true,
    }));
  }

  /**
   * Unread mention count across all workspaces the caller is a member
   * of. Driven off `UserChannelReadState.lastReadAt` so opening a
   * channel clears both its unread messages AND its mentions.
   */
  async unreadCount(userId: string): Promise<number> {
    const result = await this.prisma.$queryRaw<[{ count: bigint | number }]>`
      SELECT COUNT(*)::bigint AS count
      FROM "Message" m
      JOIN "Channel" c ON c.id = m."channelId"
      -- task-011 reviewer MED-3 fix (same as recent()): workspace
      -- membership gate.
      JOIN "WorkspaceMember" wm
        ON wm."workspaceId" = c."workspaceId"
       AND wm."userId" = ${userId}::uuid
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = ${userId}::uuid
       AND rs."channelId" = m."channelId"
      WHERE m."deletedAt" IS NULL
        AND m."authorId" <> ${userId}::uuid
        AND (rs."lastReadAt" IS NULL OR m."createdAt" > rs."lastReadAt")
        AND (
          m.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
          OR (m.mentions->>'everyone')::boolean IS TRUE
        )
    `;
    const row = result[0];
    return Number(row?.count ?? 0);
  }
}
