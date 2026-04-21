import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MessageMentions } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { cursorFor, decodeCursor } from './cursor/cursor';
import { extractMentions, normalizeContent } from './mentions/mention-extractor';
import {
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_THREAD_REPLIED,
  MESSAGE_UPDATED,
  THREAD_REPLY_RECIPIENT_CAP,
  type MessageCreatedPayload,
  type MessageDeletedPayload,
  type MessageThreadRepliedPayload,
  type MessageUpdatedPayload,
} from './events/message-events';
import { MENTION_RECEIVED, type MentionReceivedPayload } from './events/mention-events';

/**
 * First ~140 chars of a message, whitespace-collapsed, for the mention
 * toast snippet. Full content lives on the Message row; the snippet
 * avoids double-storing state while keeping the notification
 * self-contained if the toast arrives before `GET /me/mentions`.
 */
function buildSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 140 ? collapsed.slice(0, 140) + '…' : collapsed;
}

type MessageRow = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  contentPlain: string;
  mentions: Prisma.JsonValue;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  idempotencyKey: string | null;
  // task-014-B: null for root messages; set for replies.
  parentMessageId: string | null;
};

export type ThreadSummary = {
  replyCount: number;
  lastRepliedAt: string | null;
  recentReplyUserIds: string[];
};

export type ReactionSummary = {
  emoji: string;
  count: number;
  byMe: boolean;
};

export type AttachmentLite = {
  id: string;
  kind: 'IMAGE' | 'VIDEO' | 'FILE';
  mime: string;
  sizeBytes: number;
  originalName: string;
};

export type MessageDto = {
  id: string;
  channelId: string;
  authorId: string;
  content: string | null; // masked when deleted
  mentions: MessageMentions;
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  reactions: ReactionSummary[];
  parentMessageId: string | null;
  thread: ThreadSummary | null;
  attachments: AttachmentLite[];
};

export type ListDirection = 'before' | 'after' | 'around' | 'initial';

export type ListMessagesArgs = {
  channelId: string;
  before?: string;
  after?: string;
  around?: string;
  limit: number;
  includeDeleted: boolean;
};

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  toDto(
    row: MessageRow,
    reactions: ReactionSummary[] = [],
    thread: ThreadSummary | null = null,
    attachments: AttachmentLite[] = [],
  ): MessageDto {
    const isDeleted = row.deletedAt !== null;
    const mentions = (row.mentions ?? {
      users: [],
      channels: [],
      everyone: false,
    }) as MessageMentions;
    return {
      id: row.id,
      channelId: row.channelId,
      authorId: row.authorId,
      // soft-deleted messages keep their metadata for ordering/audit but the
      // body is masked in the wire format — ADMINs see content via the
      // includeDeleted=true path which returns rows unmasked for moderation.
      content: isDeleted ? null : row.content,
      mentions,
      edited: row.editedAt !== null,
      deleted: isDeleted,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      reactions,
      parentMessageId: row.parentMessageId,
      thread,
      // Deleted messages drop their attachments too — the wire shape
      // matches the content-masking rule above.
      attachments: isDeleted ? [] : attachments,
    };
  }

  /**
   * Batch-fetch finalized attachments for a set of messages in one
   * round-trip, grouped per messageId. Same one-query-per-page pattern
   * as `aggregateReactions` / `aggregateThreadSummaries`.
   */
  async aggregateAttachments(messageIds: string[]): Promise<Map<string, AttachmentLite[]>> {
    const out = new Map<string, AttachmentLite[]>();
    if (messageIds.length === 0) return out;
    const rows = await this.prisma.attachment.findMany({
      where: { messageId: { in: messageIds }, finalizedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        messageId: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        originalName: true,
      },
    });
    for (const a of rows) {
      if (!a.messageId) continue;
      const lite: AttachmentLite = {
        id: a.id,
        kind: a.kind as 'IMAGE' | 'VIDEO' | 'FILE',
        mime: a.mime,
        sizeBytes: Number(a.sizeBytes),
        originalName: a.originalName,
      };
      const list = out.get(a.messageId) ?? [];
      list.push(lite);
      out.set(a.messageId, list);
    }
    return out;
  }

  /**
   * Task-014-B: aggregate reply counts + last-reply metadata for a set
   * of root messages in one shot. Emits a Map keyed by rootId. Uses the
   * `(parentMessageId, createdAt)` index for the GROUP BY.
   *
   * `recentReplyUserIds` is sourced via a LATERAL subquery so the
   * distinct-user list is trimmed at 3 per root without pulling the
   * entire replies table into memory.
   */
  async aggregateThreadSummaries(rootIds: string[]): Promise<Map<string, ThreadSummary>> {
    const out = new Map<string, ThreadSummary>();
    if (rootIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<
      {
        parentMessageId: string;
        replyCount: bigint;
        lastRepliedAt: Date | null;
        recentReplyUserIds: string[];
      }[]
    >(Prisma.sql`
      SELECT
        m."parentMessageId"                              AS "parentMessageId",
        COUNT(*)::bigint                                 AS "replyCount",
        MAX(m."createdAt")                               AS "lastRepliedAt",
        COALESCE(
          (SELECT ARRAY_AGG(uid ORDER BY last_at DESC)
             FROM (
               SELECT r."authorId" AS uid, MAX(r."createdAt") AS last_at
                 FROM "Message" r
                WHERE r."parentMessageId" = m."parentMessageId"
                  AND r."deletedAt" IS NULL
                GROUP BY r."authorId"
                ORDER BY MAX(r."createdAt") DESC
                LIMIT 3
             ) top
          ),
          ARRAY[]::uuid[]
        ) AS "recentReplyUserIds"
      FROM "Message" m
      WHERE m."parentMessageId" IN (${Prisma.join(rootIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND m."deletedAt" IS NULL
      GROUP BY m."parentMessageId"
    `);
    for (const r of rows) {
      out.set(r.parentMessageId, {
        replyCount: Number(r.replyCount),
        lastRepliedAt: r.lastRepliedAt?.toISOString() ?? null,
        recentReplyUserIds: r.recentReplyUserIds ?? [],
      });
    }
    return out;
  }

  /**
   * Task-013-B: aggregate reactions across many message ids in a single
   * GROUP BY pass. Returns a Map keyed by messageId so the caller can
   * splice results onto each DTO without an N+1. `byMe` piggybacks on
   * the same query via `BOOL_OR("userId" = $viewerId)`.
   */
  async aggregateReactions(
    messageIds: string[],
    viewerId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    const out = new Map<string, ReactionSummary[]>();
    if (messageIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<
      { messageId: string; emoji: string; count: bigint; byMe: boolean }[]
    >(Prisma.sql`
      SELECT "messageId", emoji,
             COUNT(*)::bigint AS count,
             BOOL_OR("userId" = ${viewerId}::uuid) AS "byMe"
        FROM "MessageReaction"
       WHERE "messageId" IN (${Prisma.join(messageIds.map((id) => Prisma.sql`${id}::uuid`))})
       GROUP BY "messageId", emoji
       ORDER BY "messageId", count DESC, emoji ASC
    `);
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      list.push({ emoji: r.emoji, count: Number(r.count), byMe: r.byMe });
      out.set(r.messageId, list);
    }
    return out;
  }

  // ------------------------------------------------------------------ send

  /**
   * Persist a new message. Idempotency semantics:
   *   - If `idempotencyKey` is null → always create.
   *   - If the `(authorId, channelId, idempotencyKey)` row already exists with
   *     the SAME content → return that row, mark `replayed=true` so the
   *     controller can set the `Idempotency-Replayed` header.
   *   - If it exists with DIFFERENT content → 409 IDEMPOTENCY_KEY_REUSE_CONFLICT.
   */
  async send(args: {
    workspaceId: string;
    channelId: string;
    authorId: string;
    content: string;
    idempotencyKey: string | null;
    parentMessageId?: string | null;
  }): Promise<{ message: MessageRow; replayed: boolean }> {
    // task-014-B: validate reply target BEFORE the insert tx so we don't
    // need to unwind on a bad parent. Single-level depth is enforced
    // here — parent.parentMessageId must be null.
    if (args.parentMessageId) {
      const parent = await this.prisma.message.findFirst({
        where: { id: args.parentMessageId, channelId: args.channelId, deletedAt: null },
        select: { id: true, parentMessageId: true },
      });
      if (!parent) {
        throw new DomainError(
          ErrorCode.MESSAGE_PARENT_NOT_FOUND,
          'parent message not found in this channel',
        );
      }
      if (parent.parentMessageId !== null) {
        throw new DomainError(
          ErrorCode.MESSAGE_THREAD_DEPTH_EXCEEDED,
          'replies to replies are not supported (single-level threads)',
        );
      }
    }
    // Mentions resolve against workspace members / channels. Unknown handles
    // are silently dropped — client must never pre-compute this.
    const mentions = await extractMentions(this.prisma, args.workspaceId, args.content);
    // task-013-A3 (task-011-follow-6 closure): cap the mention fan-out.
    // A message `@a @b @c ...` 500 times would emit 500 outbox rows +
    // 500 WS sends in one tx — tangible latency and a DoS vector. 50
    // is generous for any legitimate conversation; overage returns
    // 422 so the client can trim.
    if ((mentions.users?.length ?? 0) > 50) {
      throw new DomainError(
        ErrorCode.MESSAGE_CONTENT_INVALID,
        'message mentions too many users (max 50)',
      );
    }
    const contentPlain = normalizeContent(args.content);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            channelId: args.channelId,
            authorId: args.authorId,
            content: args.content,
            contentPlain,
            mentions: mentions as unknown as Prisma.InputJsonValue,
            idempotencyKey: args.idempotencyKey,
            parentMessageId: args.parentMessageId ?? null,
          },
        });
        const payload: MessageCreatedPayload = {
          workspaceId: args.workspaceId,
          channelId: args.channelId,
          actorId: args.authorId,
          message: {
            id: created.id,
            authorId: created.authorId,
            content: created.content,
            mentions,
            createdAt: created.createdAt.toISOString(),
            // task-014-B: extra field is additive — older dispatcher
            // branches that read only {id, authorId, content, …} ignore
            // it. New thread dispatcher branch reads it to route.
            parentMessageId: created.parentMessageId,
          },
        };
        await this.outbox.record(tx, {
          aggregateType: 'Message',
          aggregateId: created.id,
          eventType: MESSAGE_CREATED,
          payload,
        });

        // Task-011-B: one mention.received outbox event per unique
        // mentioned user. Deduped here (extractMentions can return the
        // same id twice if a user is named multiple times in one
        // message). Author is NEVER notified for self-mentions.
        const snippet = buildSnippet(args.content);
        const mentionedUserIds = new Set<string>();
        for (const uid of mentions.users) {
          if (!uid || uid === args.authorId) continue;
          if (mentionedUserIds.has(uid)) continue;
          mentionedUserIds.add(uid);
          const mentionPayload: MentionReceivedPayload = {
            targetUserId: uid,
            workspaceId: args.workspaceId,
            channelId: args.channelId,
            messageId: created.id,
            actorId: args.authorId,
            snippet,
            createdAt: created.createdAt.toISOString(),
            everyone: mentions.everyone === true,
          };
          await this.outbox.record(tx, {
            aggregateType: 'UserMention',
            aggregateId: uid,
            eventType: MENTION_RECEIVED,
            payload: mentionPayload,
          });
        }

        // task-014-B: emit the aggregate thread event when this is a
        // reply. Fan-out = root author + up to 19 recent repliers, minus
        // anyone who was ALREADY toasted via mention.received for this
        // message. Dispatcher-side dedupe (mention precedes reply) picks
        // the winner when both fire — see dispatcher.ts.
        if (created.parentMessageId) {
          const thread = await this.buildThreadReplyPayload(
            tx,
            created.parentMessageId,
            created.id,
            args.channelId,
            args.workspaceId,
            args.authorId,
            created.createdAt,
            mentionedUserIds,
          );
          if (thread) {
            await this.outbox.record(tx, {
              aggregateType: 'Message',
              aggregateId: created.parentMessageId,
              eventType: MESSAGE_THREAD_REPLIED,
              payload: thread,
            });
          }
        }
        return created as MessageRow;
      });
      this.metrics?.messagesSentTotal.inc();
      return { message: row, replayed: false };
    } catch (e) {
      // P2002 = unique violation. With null-safe partial index this only fires
      // when a real duplicate (authorId+channelId+idempotencyKey) exists.
      if (
        args.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const existing = await this.prisma.message.findFirst({
          where: {
            authorId: args.authorId,
            channelId: args.channelId,
            idempotencyKey: args.idempotencyKey,
          },
        });
        if (!existing) throw e; // race: row vanished → surface original error
        if (existing.content !== args.content) {
          throw new DomainError(
            ErrorCode.IDEMPOTENCY_KEY_REUSE_CONFLICT,
            'idempotency key already used with different content',
          );
        }
        this.metrics?.messagesSentIdempotentReplayedTotal.inc();
        return { message: existing as MessageRow, replayed: true };
      }
      throw e;
    }
  }

  /**
   * task-014-B: gather the thread.replied payload inside the send tx so
   * the counts are consistent with the row we just inserted. Returns
   * `null` when the root has been deleted between the pre-check and
   * here (rare, but possible under concurrent soft-delete).
   */
  private async buildThreadReplyPayload(
    tx: Prisma.TransactionClient,
    rootId: string,
    _newReplyId: string,
    channelId: string,
    workspaceId: string,
    replierId: string,
    replyCreatedAt: Date,
    excludeRecipients: Set<string>,
  ): Promise<MessageThreadRepliedPayload | null> {
    const root = await tx.message.findUnique({
      where: { id: rootId },
      select: { authorId: true, deletedAt: true },
    });
    if (!root || root.deletedAt) return null;

    // Aggregate replies in the same tx so the count includes the row we
    // just wrote. `ORDER BY createdAt DESC` for the last-N distinct
    // repliers; DISTINCT via a subquery so a single chatter doesn't
    // consume all 20 recipient slots.
    const rows = await tx.$queryRaw<{ total: bigint; lastAt: Date | null }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total, MAX("createdAt") AS "lastAt"
        FROM "Message"
       WHERE "parentMessageId" = ${rootId}::uuid
         AND "deletedAt" IS NULL
    `);
    const replyCount = Number(rows[0]?.total ?? 0n);
    const lastAt = rows[0]?.lastAt ?? replyCreatedAt;

    const recent = await tx.$queryRaw<{ authorId: string }[]>(Prisma.sql`
      SELECT DISTINCT ON ("authorId") "authorId"
        FROM (
          SELECT "authorId", "createdAt"
            FROM "Message"
           WHERE "parentMessageId" = ${rootId}::uuid
             AND "deletedAt" IS NULL
           ORDER BY "createdAt" DESC
           LIMIT 200
        ) latest
       ORDER BY "authorId", "createdAt" DESC
    `);
    // Keep the first 3 for the avatar stack; the outbox payload is
    // small + bounded.
    const recentReplyUserIds = recent.slice(0, 3).map((r) => r.authorId);

    // Recipients: root author first so the dispatcher can check mail
    // priority cheaply, then up to 19 recent repliers, deduped, with
    // author self-filter + already-mentioned filter applied.
    const recipients: string[] = [];
    const seen = new Set<string>();
    const push = (uid: string) => {
      if (!uid || uid === replierId) return;
      if (excludeRecipients.has(uid)) return;
      if (seen.has(uid)) return;
      seen.add(uid);
      recipients.push(uid);
    };
    push(root.authorId);
    for (const { authorId } of recent) {
      if (recipients.length >= THREAD_REPLY_RECIPIENT_CAP) break;
      push(authorId);
    }

    return {
      workspaceId,
      channelId,
      rootMessageId: rootId,
      replierId,
      replyCount,
      lastRepliedAt: lastAt.toISOString(),
      recentReplyUserIds,
      recipients,
    };
  }

  // ------------------------------------------------------------------ list

  async list(args: ListMessagesArgs): Promise<{
    items: MessageRow[];
    hasMore: boolean;
    prevCursor: string | null;
    nextCursor: string | null;
  }> {
    const { channelId, limit, includeDeleted } = args;

    const directions = [args.before, args.after, args.around].filter(Boolean).length;
    if (directions > 1) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'before / after / around are mutually exclusive',
      );
    }

    // -------- around: split into before(limit/2) + after(limit/2) around msgId
    if (args.around) {
      const anchor = await this.prisma.message.findFirst({
        where: { id: args.around, channelId },
        select: { createdAt: true, id: true },
      });
      if (!anchor) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'anchor message not found');
      }
      const half = Math.ceil(limit / 2);
      const beforeItems = await this.rawList({
        channelId,
        direction: 'before',
        cursor: { t: anchor.createdAt.toISOString(), id: anchor.id },
        inclusive: true,
        limit: half + 1,
        includeDeleted,
      });
      const afterItems = await this.rawList({
        channelId,
        direction: 'after',
        cursor: { t: anchor.createdAt.toISOString(), id: anchor.id },
        inclusive: false,
        limit: half,
        includeDeleted,
      });
      // Merge → dedupe anchor → always DESC by (createdAt, id)
      const byId = new Map<string, MessageRow>();
      for (const r of beforeItems) byId.set(r.id, r);
      for (const r of afterItems) byId.set(r.id, r);
      const items = [...byId.values()].sort((a, b) => {
        const d = b.createdAt.getTime() - a.createdAt.getTime();
        return d !== 0 ? d : b.id.localeCompare(a.id);
      });
      return {
        items,
        hasMore: false,
        prevCursor: items.length > 0 ? cursorFor(items[0]) : null,
        nextCursor: items.length > 0 ? cursorFor(items[items.length - 1]) : null,
      };
    }

    // -------- before / after / initial
    const direction: 'before' | 'after' = args.after ? 'after' : 'before';
    const cursor = args.before
      ? decodeCursor(args.before)
      : args.after
        ? decodeCursor(args.after)
        : null;

    // Fetch limit+1 to detect hasMore without another count query.
    const fetched = await this.rawList({
      channelId,
      direction,
      cursor,
      inclusive: false,
      limit: limit + 1,
      includeDeleted,
    });
    const hasMore = fetched.length > limit;
    const items = fetched.slice(0, limit);

    return {
      items,
      hasMore,
      prevCursor: items.length > 0 ? cursorFor(items[0]) : null,
      nextCursor: items.length > 0 ? cursorFor(items[items.length - 1]) : null,
    };
  }

  /**
   * Raw row-value comparison against `(channelId, createdAt, id)` index.
   * Postgres-native `(created_at, id) </> ($t, $id)` keeps the planner on an
   * Index Scan — confirmed by the EXPLAIN script and the `messages.explain`
   * integration test. Never replace with Prisma's builder: the generated
   * OR-of-AND form degrades to a Sort node once the dataset grows.
   */
  private async rawList(args: {
    channelId: string;
    direction: 'before' | 'after';
    cursor: { t: string; id: string } | null;
    inclusive: boolean; // true = use <=/>= (used for around-anchor inclusion)
    limit: number;
    includeDeleted: boolean;
  }): Promise<MessageRow[]> {
    const params: unknown[] = [args.channelId, args.limit];
    const deletedFilter = args.includeDeleted ? '' : 'AND "deletedAt" IS NULL';

    // Build the "cursor comparison" fragment. 4 cases × (before/after) × (incl/excl).
    let cursorSql = '';
    let orderSql = '';
    if (args.cursor) {
      params.push(args.cursor.t, args.cursor.id);
      const op =
        args.direction === 'before' ? (args.inclusive ? '<=' : '<') : args.inclusive ? '>=' : '>';
      cursorSql = `AND ("createdAt", id) ${op} ($3::timestamp, $4::uuid)`;
      orderSql = args.direction === 'before' ? 'DESC' : 'ASC';
    } else {
      orderSql = 'DESC'; // initial = newest first
    }

    // task-014-B: channel list is ROOTS ONLY. Replies live behind the
    // thread panel. Partial index `Message_channel_roots_idx` keeps
    // this on an index scan; without the predicate EXPLAIN showed a
    // seq scan once replies outnumbered roots.
    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey", "parentMessageId"
        FROM "Message"
       WHERE "channelId" = $1::uuid
             AND "parentMessageId" IS NULL
             ${deletedFilter}
             ${cursorSql}
       ORDER BY "createdAt" ${orderSql}, id ${orderSql}
       LIMIT $2
    `;
    const rows = await this.prisma.$queryRawUnsafe<MessageRow[]>(sql, ...params);

    // After-direction rows are fetched ASC so we flip them before returning
    // to keep the DTO contract (always createdAt DESC).
    if (args.direction === 'after') rows.reverse();
    return rows;
  }

  // ---------------------------------------------------------- thread replies

  /**
   * task-014-B: paginate replies for a single root. ASC order (oldest
   * first) matches the Slack/Discord side-panel UX. Cursor format is the
   * same opaque base64 as the main list.
   */
  async listThreadReplies(args: {
    channelId: string;
    rootId: string;
    cursor: { t: string; id: string } | null;
    limit: number;
  }): Promise<{
    root: MessageRow;
    items: MessageRow[];
    hasMore: boolean;
    nextCursor: { t: Date; id: string } | null;
    prevCursor: { t: Date; id: string } | null;
  }> {
    const root = (await this.prisma.message.findFirst({
      where: { id: args.rootId, channelId: args.channelId, deletedAt: null },
    })) as MessageRow | null;
    if (!root) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if (root.parentMessageId !== null) {
      // Replies cannot themselves host threads — catches a client that
      // opened a thread panel on a reply id.
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'id is not a thread root');
    }

    const params: unknown[] = [args.rootId, args.limit + 1];
    let cursorSql = '';
    if (args.cursor) {
      params.push(args.cursor.t, args.cursor.id);
      cursorSql = `AND ("createdAt", id) > ($3::timestamp, $4::uuid)`;
    }
    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey", "parentMessageId"
        FROM "Message"
       WHERE "parentMessageId" = $1::uuid
             AND "deletedAt" IS NULL
             ${cursorSql}
       ORDER BY "createdAt" ASC, id ASC
       LIMIT $2
    `;
    const fetched = await this.prisma.$queryRawUnsafe<MessageRow[]>(sql, ...params);
    const hasMore = fetched.length > args.limit;
    const items = fetched.slice(0, args.limit);
    return {
      root,
      items,
      hasMore,
      // Always produce both cursors so the client can jump either way.
      // The main list uses opaque strings, we return structured shapes
      // here so the controller can encode via `cursorFor`.
      prevCursor: items.length > 0 ? { t: items[0].createdAt, id: items[0].id } : null,
      nextCursor:
        items.length > 0
          ? { t: items[items.length - 1].createdAt, id: items[items.length - 1].id }
          : null,
    };
  }

  // ------------------------------------------------------------------ get

  async getOne(args: {
    channelId: string;
    msgId: string;
    includeDeleted?: boolean;
  }): Promise<MessageRow | null> {
    const row = await this.prisma.message.findFirst({
      where: {
        id: args.msgId,
        channelId: args.channelId,
        ...(args.includeDeleted ? {} : { deletedAt: null }),
      },
    });
    return (row as MessageRow | null) ?? null;
  }

  async requireOne(args: {
    channelId: string;
    msgId: string;
    includeDeleted?: boolean;
  }): Promise<MessageRow> {
    const row = await this.getOne(args);
    if (!row) throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    return row;
  }

  // ------------------------------------------------------------------ update

  async update(args: {
    workspaceId: string;
    channelId: string;
    msgId: string;
    actorId: string;
    content: string;
  }): Promise<MessageRow> {
    const mentions = await extractMentions(this.prisma, args.workspaceId, args.content);
    const contentPlain = normalizeContent(args.content);
    const editedAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      // Defensive check: even though MessageAuthorGuard 404s on deleted rows,
      // the service is also callable from tests/scripts. `updateMany` returns
      // count=0 when the soft-delete predicate fails, so we can tell apart
      // "no such row" from "row was soft-deleted" without a second query.
      const { count } = await tx.message.updateMany({
        where: { id: args.msgId, channelId: args.channelId, deletedAt: null },
        data: {
          content: args.content,
          contentPlain,
          mentions: mentions as unknown as Prisma.InputJsonValue,
          editedAt,
        },
      });
      if (count === 0) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found or deleted');
      }
      const updated = (await tx.message.findUnique({ where: { id: args.msgId } }))!;
      const payload: MessageUpdatedPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        message: {
          id: updated.id,
          authorId: updated.authorId,
          content: updated.content,
          mentions,
          editedAt: editedAt.toISOString(),
        },
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_UPDATED,
        payload,
      });
      return updated as MessageRow;
    });
  }

  // ------------------------------------------------------------------ delete

  async softDelete(args: {
    workspaceId: string;
    channelId: string;
    msgId: string;
    actorId: string;
  }): Promise<void> {
    const deletedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.message.update({
        where: { id: args.msgId },
        data: { deletedAt },
      });
      const payload: MessageDeletedPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        message: {
          id: updated.id,
          authorId: updated.authorId,
          deletedAt: deletedAt.toISOString(),
        },
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_DELETED,
        payload,
      });
    });
  }
}
