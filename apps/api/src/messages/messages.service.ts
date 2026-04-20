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
  MESSAGE_UPDATED,
  type MessageCreatedPayload,
  type MessageDeletedPayload,
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

  toDto(row: MessageRow): MessageDto {
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
    };
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
  }): Promise<{ message: MessageRow; replayed: boolean }> {
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
        const seen = new Set<string>();
        for (const uid of mentions.users) {
          if (!uid || uid === args.authorId) continue;
          if (seen.has(uid)) continue;
          seen.add(uid);
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

    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey"
        FROM "Message"
       WHERE "channelId" = $1::uuid
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
