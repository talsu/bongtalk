import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';

export interface UnreadChannelSummary {
  channelId: string;
  unreadCount: number;
  hasMention: boolean;
  lastMessageAt: string | null;
}

/**
 * Task-010-B: Unread summary for every channel in a workspace the caller
 * can read. One round-trip, no per-channel N+1. EXPLAIN was verified
 * during task-010-B dev to use index scan on `Message.(channelId, createdAt)`
 * — the existing partial index from task-004 covers this query shape.
 *
 * lastReadAt is the threshold: messages with createdAt > lastReadAt are
 * unread. When UserChannelReadState row is missing for (userId, channelId)
 * the LEFT JOIN yields NULL and the LATERAL subquery treats that as
 * "every message is unread" — matching the expected UX for a freshly-
 * joined workspace.
 *
 * Mentions are detected via JSONB containment: `mentions @>
 * '{"users":[<userId>]}'` matches the exact user id; an `everyone: true`
 * also lights the has-mention flag.
 */
@Injectable()
export class UnreadService {
  constructor(private readonly prisma: PrismaService) {}

  async summarize(workspaceId: string, userId: string): Promise<UnreadChannelSummary[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        channel_id: string;
        unread_count: bigint | number;
        has_mention: boolean;
        last_message_at: Date | null;
      }>
    >`
      SELECT
        c.id AS channel_id,
        COALESCE(m.count_after, 0)      AS unread_count,
        COALESCE(m.has_mention, false)  AS has_mention,
        m.latest_at                     AS last_message_at
      FROM "Channel" c
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = ${userId}::uuid
       AND rs."channelId" = c.id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS count_after,
          bool_or(
            msg.mentions @> jsonb_build_object('users', jsonb_build_array(${userId}::text))
            OR (msg.mentions->>'everyone')::boolean IS TRUE
          ) AS has_mention,
          max(msg."createdAt") AS latest_at
        FROM "Message" msg
        WHERE msg."channelId" = c.id
          AND msg."deletedAt" IS NULL
          AND msg."authorId" <> ${userId}::uuid
          AND (rs."lastReadAt" IS NULL OR msg."createdAt" > rs."lastReadAt")
      ) m ON true
      WHERE c."workspaceId" = ${workspaceId}::uuid
        AND c."deletedAt" IS NULL
      ORDER BY c."createdAt" ASC
    `;

    return rows.map((r) => ({
      channelId: r.channel_id,
      unreadCount: Number(r.unread_count ?? 0),
      hasMention: r.has_mention === true,
      lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
    }));
  }

  /**
   * Mark everything up to `now()` as read for (userId, channelId).
   * Schema holds `lastReadEventId` (UUID, FK-less pointer to OutboxEvent.id)
   * — we don't actually need a valid event id for the unread-count logic
   * since the query drives off `lastReadAt`. Stamp a fresh UUID so the
   * column remains non-null; event-id-based replay (task-005) still
   * uses its own path.
   */
  async markRead(userId: string, channelId: string): Promise<{ readAt: Date }> {
    const readAt = new Date();
    await this.prisma.userChannelReadState.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: {
        userId,
        channelId,
        lastReadEventId: randomUUID(),
        lastReadAt: readAt,
      },
      update: {
        lastReadAt: readAt,
      },
    });
    return { readAt };
  }
}
