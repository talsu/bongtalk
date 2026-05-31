import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ReadStateUpdatedPayload } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

export interface UnreadChannelSummary {
  channelId: string;
  unreadCount: number;
  hasMention: boolean;
  lastMessageAt: string | null;
}

export interface UnreadWorkspaceTotal {
  workspaceId: string;
  unreadCount: number;
  hasMention: boolean;
}

/**
 * Task-010-B → S11: Unread summary for every channel in a workspace the
 * caller can read. One round-trip, no per-channel N+1.
 *
 * S11 (FR-RT-14) — (createdAt, id) 튜플 커서 공식.
 * Message.id 는 `@default(uuid())` 랜덤 UUID(비정렬)라 `id >` 문자열 비교가
 * 메시지 순서와 무관하다. 따라서 읽음/미읽음 판정은 메시지 커서 페이지네이션
 * (messages.service)과 동일하게 (createdAt, id) 튜플로 비교한다:
 *
 *   unread ⇔ (m.createdAt, m.id) > (rs.lastReadMessageCreatedAt,
 *                                   rs.lastReadMessageId)
 *
 * read-state row 가 없거나 커서가 NULL 이면 LEFT JOIN 이 NULL 을 만들고
 * 튜플 비교가 "전부 미읽음" 으로 평가된다(새로 가입한 채널 UX 일치).
 *
 * S11 변경점: 기존 createdAt 단독 임계(`lastReadAt`)를 폐기하고, **senderId
 * 제외 조건(`authorId <> userId`)을 제거**한다 — 자기 메시지도 미읽음으로
 * 집계한다(FR-RT-14). createdAt 동률(tie)은 id 로 가름한다.
 *
 * Mentions are detected via JSONB containment: `mentions @>
 * '{"users":[<userId>]}'` matches the exact user id; an `everyone: true`
 * also lights the has-mention flag.
 *
 * Task-019-A: channel visibility is enforced SQL-side (private channels
 * need OWNER caller or a matching ALLOW override). Integration regression
 * guard: `apps/api/test/int/channels/unread-private-acl.int.spec.ts`.
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
      WITH me AS (
        SELECT role
          FROM "WorkspaceMember"
         WHERE "workspaceId" = ${workspaceId}::uuid
           AND "userId" = ${userId}::uuid
      ),
      -- task-019-A + reviewer BLOCKER-1 fix: effective READ = ALLOW & ~DENY.
      overrides AS (
        SELECT
          cpo."channelId",
          COALESCE(bit_or(cpo."allowMask"), 0) AS allow_mask,
          COALESCE(bit_or(cpo."denyMask"), 0)  AS deny_mask
        FROM "ChannelPermissionOverride" cpo
        WHERE (
          (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
          OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = (SELECT role::text FROM me))
        )
        GROUP BY cpo."channelId"
      ),
      visible_channels AS (
        SELECT c.id, c."createdAt"
          FROM "Channel" c
          LEFT JOIN overrides o ON o."channelId" = c.id
         WHERE c."workspaceId" = ${workspaceId}::uuid
           AND c."deletedAt" IS NULL
           AND (
             c."isPrivate" = false
             OR (SELECT role::text FROM me) = 'OWNER'
             OR (COALESCE(o.allow_mask, 0) & ~COALESCE(o.deny_mask, 0) & 1) > 0
           )
      )
      SELECT
        c.id AS channel_id,
        COALESCE(m.count_after, 0)      AS unread_count,
        COALESCE(m.has_mention, false)  AS has_mention,
        m.latest_at                     AS last_message_at
      FROM visible_channels c
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
          -- S11 (FR-RT-14): (createdAt, id) 튜플 커서. read-state NULL ⇒ 전부 미읽음.
          -- senderId 제외 없음(자기 메시지 포함). createdAt 동률은 id 로 가름.
          AND (
            rs."lastReadMessageCreatedAt" IS NULL
            OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
          )
      ) m ON true
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
   * Task-018-E → S11: workspace-level unread aggregate for the server rail.
   * Same (createdAt, id) tuple formula as `summarize`, summed per workspace.
   * Self-inclusive (no authorId filter) — FR-RT-14. ACL filter (task-019-A)
   * unchanged.
   */
  async summarizeWorkspaceTotals(userId: string): Promise<UnreadWorkspaceTotal[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        workspace_id: string;
        unread_count: bigint | number;
        has_mention: boolean;
      }>
    >`
      SELECT
        wm."workspaceId"                AS workspace_id,
        COALESCE(SUM(u.count_after), 0) AS unread_count,
        COALESCE(bool_or(u.has_mention), false) AS has_mention
      FROM "WorkspaceMember" wm
      JOIN "Channel" c
        ON c."workspaceId" = wm."workspaceId"
       AND c."deletedAt" IS NULL
       AND (
         c."isPrivate" = false
         OR wm.role = 'OWNER'
         OR COALESCE(
              (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                 FROM "ChannelPermissionOverride" cpo
                WHERE cpo."channelId" = c.id
                  AND (
                    (cpo."principalType" = 'USER' AND cpo."principalId" = wm."userId"::text)
                    OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                  )),
              0
            ) > 0
       )
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = wm."userId"
       AND rs."channelId" = c.id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS count_after,
          bool_or(
            msg.mentions @> jsonb_build_object('users', jsonb_build_array(wm."userId"::text))
            OR (msg.mentions->>'everyone')::boolean IS TRUE
          ) AS has_mention
        FROM "Message" msg
        WHERE msg."channelId" = c.id
          AND msg."deletedAt" IS NULL
          -- S11 (FR-RT-14): (createdAt, id) 튜플 커서. self-inclusive.
          AND (
            rs."lastReadMessageCreatedAt" IS NULL
            OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
          )
      ) u ON true
      WHERE wm."userId" = ${userId}::uuid
      GROUP BY wm."workspaceId"
      ORDER BY wm."workspaceId" ASC
    `;

    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      unreadCount: Number(r.unread_count ?? 0),
      hasMention: r.has_mention === true,
    }));
  }

  /**
   * S11 (FR-RT-14): single-channel unread recount with the same tuple
   * cursor formula. Used by `ackRead` to compute the post-ack count for the
   * `read_state:updated` payload. No ACL filter — the caller (ack path) has
   * already passed ChannelAccessGuard, so the channel is readable.
   */
  async unreadCountFor(userId: string, channelId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ unread_count: bigint | number }>>`
      SELECT COALESCE((
        SELECT count(*)
          FROM "Message" msg
          LEFT JOIN "UserChannelReadState" rs
            ON rs."userId" = ${userId}::uuid
           AND rs."channelId" = ${channelId}::uuid
         WHERE msg."channelId" = ${channelId}::uuid
           AND msg."deletedAt" IS NULL
           AND (
             rs."lastReadMessageCreatedAt" IS NULL
             OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
           )
      ), 0) AS unread_count
    `;
    return Number(rows[0]?.unread_count ?? 0);
  }

  /**
   * S11 (FR-RT-13 / FR-RT-19): ack a read up to `lastReadMessageId`.
   *
   *  1. validate the message belongs to `channelId` (else 404).
   *  2. monotonic (createdAt, id) tuple upsert — advance ONLY when the new
   *     tuple is strictly greater than the stored one (cursor 퇴행 방지).
   *  3. recompute unreadCount with the tuple formula.
   *  4. return the `read_state:updated` payload for the caller to emit to
   *     `user:{userId}`.
   *
   * The upsert is monotonic via a conditional UPDATE guarded on the stored
   * tuple. When the incoming ack is older (퇴행) the UPDATE matches zero rows
   * and the stored cursor is left intact — but the recount + payload still
   * reflect the current (unchanged) cursor so a no-op ack is idempotent.
   */
  async ackRead(args: {
    userId: string;
    channelId: string;
    lastReadMessageId: string;
  }): Promise<ReadStateUpdatedPayload> {
    const { userId, channelId, lastReadMessageId } = args;

    const msg = await this.prisma.message.findFirst({
      where: { id: lastReadMessageId, channelId, deletedAt: null },
      select: { id: true, createdAt: true },
    });
    if (!msg) {
      throw new DomainError(
        ErrorCode.MESSAGE_NOT_FOUND,
        'lastReadMessageId does not belong to this channel',
      );
    }

    // INSERT … ON CONFLICT DO UPDATE … WHERE (monotonic guard). The WHERE on
    // the UPDATE branch only advances when the new tuple is strictly greater,
    // so a stale/out-of-order ack is a no-op (cursor never regresses).
    // `lastReadEventId` stays non-null (reconnect-replay column) — we stamp a
    // fresh uuid on insert and leave it untouched on update.
    await this.prisma.$executeRaw`
      INSERT INTO "UserChannelReadState"
        ("userId", "channelId", "lastReadEventId", "lastReadAt",
         "lastReadMessageId", "lastReadMessageCreatedAt", "updatedAt")
      VALUES
        (${userId}::uuid, ${channelId}::uuid, ${randomUUID()}::uuid, ${msg.createdAt},
         ${msg.id}::uuid, ${msg.createdAt}, now())
      ON CONFLICT ("userId", "channelId") DO UPDATE
        SET "lastReadMessageId" = EXCLUDED."lastReadMessageId",
            "lastReadMessageCreatedAt" = EXCLUDED."lastReadMessageCreatedAt",
            "lastReadAt" = EXCLUDED."lastReadAt",
            "updatedAt" = now()
        WHERE "UserChannelReadState"."lastReadMessageCreatedAt" IS NULL
           OR (
             "UserChannelReadState"."lastReadMessageCreatedAt",
             "UserChannelReadState"."lastReadMessageId"
           ) < (EXCLUDED."lastReadMessageCreatedAt", EXCLUDED."lastReadMessageId")
    `;

    // Read back the EFFECTIVE cursor — on a 퇴행 ack the UPDATE was a no-op so
    // the persisted cursor is the previous (greater) one, and the payload must
    // reflect that, not the stale id the client sent.
    const current = await this.prisma.userChannelReadState.findUnique({
      where: { userId_channelId: { userId, channelId } },
      select: { lastReadMessageId: true },
    });

    const unreadCount = await this.unreadCountFor(userId, channelId);

    return {
      channelId,
      lastReadMessageId: current?.lastReadMessageId ?? lastReadMessageId,
      unreadCount,
    };
  }

  /**
   * @deprecated S11 (FR-RT-13): `POST .../read` 의 백엔드 처리. ack 엔드포인트로
   * 통합되었으나 엔드포인트 자체는 호환을 위해 유지된다. message id 없이
   * 호출되므로 "현재 채널 최신 메시지까지 읽음" 으로 해석해 monotonic 하게
   * 커서를 전진시킨다. 채널에 메시지가 없으면 read-state 만 보장(no-op cursor).
   */
  async markRead(userId: string, channelId: string): Promise<{ readAt: Date }> {
    const latest = await this.prisma.message.findFirst({
      where: { channelId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });

    if (latest) {
      await this.ackRead({ userId, channelId, lastReadMessageId: latest.id });
      return { readAt: latest.createdAt };
    }

    // Empty channel — ensure a read-state row exists (legacy lastReadAt path)
    // without a message cursor. Keeps `/read` non-throwing on fresh channels.
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
