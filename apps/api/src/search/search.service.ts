import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { Permission, PermissionMatrix } from '../auth/permissions';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

export type SearchResultRow = {
  messageId: string;
  channelId: string;
  channelName: string;
  senderId: string;
  senderName: string;
  createdAt: string;
  snippet: string; // contains <mark>…</mark> from ts_headline
  rank: number;
};

/**
 * Opaque cursor: base64url(JSON({rank, createdAt, id})). The tuple is
 * the exact sort key of the SELECT so keyset pagination stays stable
 * across repeated calls with the same `q`. We never expose rank / id
 * as separate query-string params — the cursor is the contract.
 */
type SearchCursor = { rank: number; createdAt: string; id: string };

function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): SearchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed.rank === 'number' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return parsed as SearchCursor;
    }
  } catch {
    /* fallthrough */
  }
  throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'invalid search cursor');
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the viewer's channel visibility set within a workspace.
   * The search query filters by `channelId = ANY(...)` so hidden
   * channels never enter the planner's scope. A second per-result
   * check happens in `search()` to cover the edge case where ACL
   * flipped between query and response assembly.
   *
   * Task-016-B (015-follow-2 closure): previously looped
   * `resolveEffective` per channel — O(channels) round trips. Now
   * two batched queries + in-memory fold through `PermissionMatrix`.
   */
  private async visibleChannelIds(workspaceId: string, userId: string): Promise<string[]> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) return []; // non-member sees nothing
    const [channels, overrides] = await Promise.all([
      this.prisma.channel.findMany({
        where: { workspaceId, deletedAt: null, archivedAt: null },
        select: { id: true, workspaceId: true, isPrivate: true },
      }),
      this.prisma.channelPermissionOverride.findMany({
        where: {
          channel: { workspaceId, deletedAt: null, archivedAt: null },
          OR: [
            { principalType: 'USER', principalId: userId },
            { principalType: 'ROLE', principalId: member.role },
          ],
        },
        select: {
          channelId: true,
          principalType: true,
          principalId: true,
          allowMask: true,
          denyMask: true,
        },
      }),
    ]);
    const byChannel = new Map<
      string,
      Array<{
        principalType: 'USER' | 'ROLE';
        principalId: string;
        allowMask: number;
        denyMask: number;
      }>
    >();
    for (const o of overrides) {
      const list = byChannel.get(o.channelId) ?? [];
      list.push({
        principalType: o.principalType as 'USER' | 'ROLE',
        principalId: o.principalId,
        allowMask: o.allowMask,
        denyMask: o.denyMask,
      });
      byChannel.set(o.channelId, list);
    }
    const ids: string[] = [];
    for (const ch of channels) {
      const eff = PermissionMatrix.effective({
        role: member.role,
        isPrivate: ch.isPrivate,
        userId,
        overrides: byChannel.get(ch.id) ?? [],
      });
      if ((eff & Permission.READ) === Permission.READ) ids.push(ch.id);
    }
    return ids;
  }

  async search(args: {
    query: string;
    workspaceId: string;
    userId: string;
    channelId?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ results: SearchResultRow[]; nextCursor: string | null }> {
    const q = args.query.trim();
    if (q.length === 0) {
      return { results: [], nextCursor: null };
    }
    const cursor = args.cursor ? decodeCursor(args.cursor) : null;

    let visibleIds = await this.visibleChannelIds(args.workspaceId, args.userId);
    if (args.channelId) {
      // Optional narrowing — still has to be within the visibility set.
      visibleIds = visibleIds.filter((id) => id === args.channelId);
    }
    if (visibleIds.length === 0) {
      return { results: [], nextCursor: null };
    }

    // task-016-B (015-follow-3 closure): wrap the base match in a
    // subquery that computes `rank` once per row. The cursor
    // predicate and the ORDER BY both reference the aliased value
    // instead of re-evaluating `ts_rank(...)` — verified by EXPLAIN,
    // the Function Scan on ts_rank appears exactly once per row.
    const cursorWhere = cursor
      ? Prisma.sql`
          WHERE (base.rank, base."createdAt", base.id)
                < (${cursor.rank}::float4, ${cursor.createdAt}::timestamp, ${cursor.id}::uuid)
        `
      : Prisma.empty;

    // Fetch limit+1 so we know when there's more.
    const fetched = await this.prisma.$queryRaw<
      {
        messageId: string;
        channelId: string;
        channelName: string;
        senderId: string;
        senderName: string;
        createdAt: Date;
        snippet: string;
        rank: number;
      }[]
    >(Prisma.sql`
      WITH base AS (
        SELECT
          m.id            AS id,
          m."channelId"   AS "channelId",
          m."authorId"    AS "authorId",
          m."createdAt"   AS "createdAt",
          m."content"     AS content,
          ts_rank(m."search_tsv", plainto_tsquery('simple', ${q})) AS rank
          FROM "Message" m
         WHERE m."deletedAt" IS NULL
           AND m."channelId" = ANY(
                 ARRAY[${Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]
               )
           AND (
                m."search_tsv" @@ plainto_tsquery('simple', ${q})
             OR m."content" ILIKE '%' || ${q} || '%'
           )
      )
      SELECT
        base.id            AS "messageId",
        base."channelId"   AS "channelId",
        c.name             AS "channelName",
        base."authorId"    AS "senderId",
        u.username         AS "senderName",
        base."createdAt"   AS "createdAt",
        -- HTML-escape the content BEFORE ts_headline so the only
        -- HTML in the snippet is the StartSel/StopSel markers we
        -- told Postgres to use. Frontend can then render with
        -- dangerouslySetInnerHTML (via the mark-only sanitizer) —
        -- only <mark>…</mark> tags ever make it to the wire.
        ts_headline(
          'simple',
          replace(replace(replace(base.content, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
          plainto_tsquery('simple', ${q}),
          'StartSel=<mark>,StopSel=</mark>,MaxWords=18,MinWords=3'
        ) AS snippet,
        base.rank          AS rank
        FROM base
        JOIN "Channel" c ON c.id = base."channelId"
        JOIN "User"    u ON u.id = base."authorId"
       ${cursorWhere}
       ORDER BY base.rank DESC, base."createdAt" DESC, base.id DESC
       LIMIT ${args.limit + 1}
    `);

    const hasMore = fetched.length > args.limit;
    const rows = fetched.slice(0, args.limit);
    const last = rows[rows.length - 1];

    return {
      results: rows.map((r) => ({
        messageId: r.messageId,
        channelId: r.channelId,
        channelName: r.channelName,
        senderId: r.senderId,
        senderName: r.senderName,
        createdAt: r.createdAt.toISOString(),
        snippet: r.snippet,
        rank: Number(r.rank),
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              rank: Number(last.rank),
              createdAt: last.createdAt.toISOString(),
              id: last.messageId,
            })
          : null,
    };
  }
}
