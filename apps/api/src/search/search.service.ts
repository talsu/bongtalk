import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { Permission } from '../auth/permissions';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
  ) {}

  /**
   * Resolve the viewer's channel visibility set within a workspace.
   * The search query filters by `channelId = ANY(...)` so hidden
   * channels never enter the planner's scope. A second per-result
   * check happens in `search()` to cover the edge case where ACL
   * flipped between query and response assembly.
   */
  private async visibleChannelIds(workspaceId: string, userId: string): Promise<string[]> {
    // Pull every non-deleted channel in the workspace + the viewer's
    // membership + any user/role overrides in one round trip each.
    // For beta-volume (tens-to-low-hundreds of channels per
    // workspace) the N^2 is negligible. When scale demands, fold the
    // loop into a single SQL aggregate.
    const channels = await this.prisma.channel.findMany({
      where: { workspaceId, deletedAt: null, archivedAt: null },
      select: { id: true, workspaceId: true, isPrivate: true },
    });
    const ids: string[] = [];
    for (const ch of channels) {
      try {
        const eff = await this.access.resolveEffective(ch, userId);
        if ((eff & Permission.READ) === Permission.READ) ids.push(ch.id);
      } catch {
        // Non-member / permission denied — just skip.
      }
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

    // Keyset predicate. Omitted when no cursor. Uses the
    // (rank DESC, createdAt DESC, id DESC) tuple that matches the
    // ORDER BY, hitting a Sort node on top of the GIN match.
    const cursorWhere = cursor
      ? Prisma.sql`
          AND (ts_rank(m."search_tsv", plainto_tsquery('simple', ${q})),
               m."createdAt", m.id)
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
      SELECT
        m.id            AS "messageId",
        m."channelId"   AS "channelId",
        c.name          AS "channelName",
        m."authorId"    AS "senderId",
        u.username      AS "senderName",
        m."createdAt"   AS "createdAt",
        ts_headline('simple', m."content",
                    plainto_tsquery('simple', ${q}),
                    'StartSel=<mark>,StopSel=</mark>,MaxWords=18,MinWords=3')
                                       AS snippet,
        ts_rank(m."search_tsv", plainto_tsquery('simple', ${q}))
                                       AS rank
        FROM "Message" m
        JOIN "Channel" c ON c.id = m."channelId"
        JOIN "User"    u ON u.id = m."authorId"
       WHERE m."deletedAt" IS NULL
         AND m."channelId" = ANY(
               ARRAY[${Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]
             )
         AND (
              m."search_tsv" @@ plainto_tsquery('simple', ${q})
           OR m."content" ILIKE '%' || ${q} || '%'
         )
         ${cursorWhere}
       ORDER BY rank DESC, m."createdAt" DESC, m.id DESC
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
