import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { Permission, PermissionMatrix } from '../auth/permissions';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { parseSearchQuery } from './search-query.parser';

/**
 * S30 (FR-S06): 결과 카드의 전/후 컨텍스트 메시지 한 줄. 권한 재검증 결과에
 * 따라 `masked` 가 true 면 본문(text)은 null 로 마스킹합니다.
 */
export type SearchContextMessageRow = {
  // S30 fix-forward (BLOCKER 보안 A1): masked=true 면 식별정보(PK·시각)도
  // null 로 내려보내 권한 없는 채널 메시지의 ID·정확한 시각 누출을 막습니다.
  messageId: string | null;
  senderName: string | null;
  text: string | null;
  createdAt: string | null;
  masked: boolean;
};

/** S29 (FR-S08): 정렬 모드 — 관련도(기본) 또는 최신. */
export type SearchSort = 'relevance' | 'recent';

export type SearchResultRow = {
  messageId: string;
  channelId: string;
  channelName: string;
  senderId: string;
  senderName: string;
  createdAt: string;
  snippet: string; // contains <mark>…</mark> from ts_headline
  rank: number;
  // ── S30 (FR-S06 / FR-S10) — withContext=true 에서만 채워지는 optional ──────
  contextBefore?: SearchContextMessageRow | null;
  contextAfter?: SearchContextMessageRow | null;
  inThread?: boolean;
  threadRootExcerpt?: string | null;
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

// S29 (security MEDIUM): cursor.id 도 SQL 에서 `${cursor.id}::uuid` 로 캐스팅
// 되므로 forged cursor 의 비-UUID id 가 DB 500 으로 누출될 수 있다. createdAt
// 도 `::timestamp` 캐스팅 대상이라 형식을 함께 검증한다(비정상 → 빈 cursor 와
// 동일하게 MESSAGE_CURSOR_INVALID 400).
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string): SearchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed.rank === 'number' &&
      Number.isFinite(parsed.rank) &&
      typeof parsed.createdAt === 'string' &&
      !Number.isNaN(new Date(parsed.createdAt).getTime()) &&
      typeof parsed.id === 'string' &&
      CURSOR_UUID_RE.test(parsed.id)
    ) {
      return parsed as SearchCursor;
    }
  } catch {
    /* fallthrough */
  }
  throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'invalid search cursor');
}

/**
 * S29 (FR-S05): 컨트롤러 명시값과 파서 유도값 중 더 좁히는 쪽을 고른다.
 *   lower(since) → 더 큰 값(늦은 하한)이 더 좁다.
 *   upper(until) → 더 작은 값(이른 상한)이 더 좁다.
 * 둘 중 하나만 있으면 그것을, 둘 다 없으면 undefined.
 */
function pickTighter(
  a: Date | undefined,
  b: Date | undefined,
  side: 'lower' | 'upper',
): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  if (side === 'lower') return a.getTime() >= b.getTime() ? a : b;
  return a.getTime() <= b.getTime() ? a : b;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

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

  /**
   * S29 (FR-S04 오라클 방지): in:#channel 의 채널명을 *이미 계산된 가시 집합
   * 안에서만* id 로 해석한다. 가시 집합 밖(비공개 비멤버·미존재)이면 null 을
   * 돌려주고, 호출측이 0건으로 처리한다. 가시 집합으로 `id: { in: visibleIds }`
   * 를 걸므로 비멤버 채널은 애초에 후보에 없어 존재 추론이 불가능하다.
   * (대소문자 무시 — 채널명은 unique-insensitive 관례.)
   */
  private async resolveVisibleChannelByName(
    visibleIds: string[],
    name: string,
    workspaceId: string,
  ): Promise<string | null> {
    if (visibleIds.length === 0) return null;
    const ch = await this.prisma.channel.findFirst({
      where: {
        workspaceId,
        deletedAt: null,
        id: { in: visibleIds },
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    return ch?.id ?? null;
  }

  /**
   * S29 (FR-S04): from:@user 핸들을 워크스페이스 멤버 안에서 userId 로 해석.
   * 멤버가 아니거나 미존재 핸들이면 null → 호출측 0건. 워크스페이스 멤버십을
   * 걸어 외부 사용자 존재가 새지 않게 한다(대소문자 무시).
   */
  private async resolveWorkspaceMemberByHandle(
    workspaceId: string,
    handle: string,
  ): Promise<string | null> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        user: { username: { equals: handle, mode: 'insensitive' } },
      },
      select: { userId: true },
    });
    return member?.userId ?? null;
  }

  async search(args: {
    query: string;
    workspaceId: string;
    userId: string;
    channelId?: string;
    /** task-046 iter3 (J3): filter by message author */
    senderId?: string;
    /** task-046 iter3 (J3): inclusive lower bound on createdAt */
    since?: Date;
    /** task-046 iter3 (J3): exclusive upper bound on createdAt */
    until?: Date;
    /** task-046 iter3 (J3): when true, only messages with at least 1 attachment */
    hasAttachment?: boolean;
    /** S29 (FR-S08): 정렬 모드. 기본 relevance(ts_rank_cd). */
    sort?: SearchSort;
    cursor?: string;
    limit: number;
    /** S29 (FR-S05 / during:): 상대 기간 기준 시각(테스트 주입). */
    now?: Date;
  }): Promise<{ results: SearchResultRow[]; nextCursor: string | null }> {
    // S29 (FR-S05): 수식어 파싱. from/in/has/is/before/after/during 토큰을
    // 추출하고 잔여 텍스트만 tsquery 로 넘긴다. 컨트롤러가 넘긴 명시
    // senderId/since/until/hasAttachment 와 AND 병합한다(둘 다 좁히는 방향).
    const parsed = parseSearchQuery(args.query, args.now ?? new Date());
    const sort: SearchSort = args.sort ?? 'relevance';

    // since/until: 컨트롤러 명시값과 파서 유도값 중 더 좁은(엄격한) 쪽 채택.
    const since = pickTighter(args.since, parsed.since, 'lower');
    const until = pickTighter(args.until, parsed.until, 'upper');
    // 범위가 공집합이면 0건.
    if (since && until && since >= until) {
      return { results: [], nextCursor: null };
    }

    const q = parsed.text.trim();
    const cursor = args.cursor ? decodeCursor(args.cursor) : null;

    let visibleIds = await this.visibleChannelIds(args.workspaceId, args.userId);
    if (args.channelId) {
      // Optional narrowing — still has to be within the visibility set.
      visibleIds = visibleIds.filter((id) => id === args.channelId);
    }

    // S29 (FR-S04 오라클 방지): in:#channel 지정 시 가시 채널 집합 안에서만
    // 이름→id 를 해석한다. 비멤버/비공개/미존재 채널을 가리키면 visibleIds 를
    // 빈 집합으로 만들어 *조용히 0건* 을 돌려준다(403/404 아님 — 채널 존재·
    // 멤버십을 추론할 수 없게 한다). 같은 이유로 채널 존재 여부를 별도 쿼리로
    // 확인하지 않는다(가시 집합 밖은 일괄 미해결 처리).
    if (parsed.inChannel !== undefined) {
      const resolved = await this.resolveVisibleChannelByName(
        visibleIds,
        parsed.inChannel,
        args.workspaceId,
      );
      visibleIds = resolved ? [resolved] : [];
    }

    // S29 (FR-S04 오라클 방지): from:@user 도 워크스페이스 멤버 안에서만
    // 해석한다. 미존재 핸들이면 0건(senderId 미세팅이 아니라 매칭 불가
    // sentinel 로 처리). 명시 senderId 와 충돌하면(둘 다 지정+불일치) 0건.
    let senderId = args.senderId;
    if (parsed.fromHandle !== undefined) {
      const fromId = await this.resolveWorkspaceMemberByHandle(args.workspaceId, parsed.fromHandle);
      if (fromId === null) {
        return { results: [], nextCursor: null };
      }
      if (senderId && senderId !== fromId) {
        return { results: [], nextCursor: null };
      }
      senderId = fromId;
    }

    if (visibleIds.length === 0) {
      return { results: [], nextCursor: null };
    }
    // q 가 비고(modifier 만 있는 쿼리, 예: `in:#general has:link`) 정렬이
    // relevance 면 rank 가 전부 0 이라 무의미하므로 recent 로 폴백한다.
    const effectiveSort: SearchSort = q.length === 0 ? 'recent' : sort;

    // task-016-B (015-follow-3 closure): wrap the base match in a
    // subquery that computes `rank` once per row. The cursor
    // predicate and the ORDER BY both reference the aliased value
    // instead of re-evaluating `ts_rank_cd(...)` — verified by EXPLAIN,
    // the Function Scan appears exactly once per row.
    //
    // S29 (FR-S08): cursor 비교 키는 정렬 모드에 맞춘다.
    //   relevance → (rank, createdAt, id) DESC
    //   recent    → (createdAt, id) DESC  (rank 무시)
    const cursorWhere = cursor
      ? effectiveSort === 'recent'
        ? Prisma.sql`
            WHERE (base."createdAt", base.id)
                  < (${cursor.createdAt}::timestamp, ${cursor.id}::uuid)
          `
        : Prisma.sql`
            WHERE (base.rank, base."createdAt", base.id)
                  < (${cursor.rank}::float4, ${cursor.createdAt}::timestamp, ${cursor.id}::uuid)
          `
      : Prisma.empty;

    // S29 (FR-S05): tsquery 텍스트 매치는 q 가 있을 때만. q 가 비면 modifier
    // 만으로 필터(전체 가시 메시지에서 추리기) — text 매치 절을 생략한다.
    const textClause =
      q.length > 0
        ? Prisma.sql`
           AND (
                m."search_tsv" @@ plainto_tsquery('simple', ${q})
             OR m."content" ILIKE '%' || ${q} || '%'
           )`
        : Prisma.empty;

    // task-046 iter3 (J3): optional filter clauses on the base CTE.
    const senderClause = senderId ? Prisma.sql`AND m."authorId" = ${senderId}::uuid` : Prisma.empty;
    const sinceClause = since ? Prisma.sql`AND m."createdAt" >= ${since}::timestamp` : Prisma.empty;
    const untilClause = until ? Prisma.sql`AND m."createdAt" < ${until}::timestamp` : Prisma.empty;
    const attachmentClause = args.hasAttachment
      ? Prisma.sql`
          AND EXISTS (
            SELECT 1 FROM "Attachment" att
             WHERE att."messageId" = m.id
               AND att."finalizedAt" IS NOT NULL
          )
        `
      : Prisma.empty;
    // S29 (FR-S05): has: 비정규화 boolean 컬럼 필터(복합 AND).
    const hasLinkClause = parsed.has.includes('link')
      ? Prisma.sql`AND m."hasLink" = true`
      : Prisma.empty;
    const hasImageClause = parsed.has.includes('image')
      ? Prisma.sql`AND m."hasImage" = true`
      : Prisma.empty;
    const hasFileClause = parsed.has.includes('file')
      ? Prisma.sql`AND m."hasFile" = true`
      : Prisma.empty;
    // S29 (FR-S05): is:pinned 은 pinnedAt IS NOT NULL(별도 컬럼 미사용).
    const pinnedClause = parsed.isPinned ? Prisma.sql`AND m."pinnedAt" IS NOT NULL` : Prisma.empty;

    // q 가 비면 plainto_tsquery 가 빈 tsquery → ts_rank_cd = 0, ts_headline 은
    // 첫 단어들을 그대로 반환. 둘 다 안전하다.
    const orderBy =
      effectiveSort === 'recent'
        ? Prisma.sql`ORDER BY base."createdAt" DESC, base.id DESC`
        : Prisma.sql`ORDER BY base.rank DESC, base."createdAt" DESC, base.id DESC`;

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
          ts_rank_cd(m."search_tsv", plainto_tsquery('simple', ${q})) AS rank
          FROM "Message" m
         WHERE m."deletedAt" IS NULL
           AND m."channelId" = ANY(
                 ARRAY[${Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]
               )
           ${textClause}
           ${senderClause}
           ${sinceClause}
           ${untilClause}
           ${attachmentClause}
           ${hasLinkClause}
           ${hasImageClause}
           ${hasFileClause}
           ${pinnedClause}
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
       ${orderBy}
       LIMIT ${args.limit + 1}
    `);

    // S29 (security HIGH): per-result ACL 재검증. visibleIds 는 쿼리 *실행 전*
    // 스냅샷이라, 쿼리와 응답 조립 사이에 ACL 이 flip(강퇴·비공개 전환·DENY
    // override 추가)되면 더 이상 가시하지 않는 채널의 행이 결과에 섞일 수 있다.
    // 이미 계산된 가시 집합을 Set 으로 만들어 응답 직전 필터한다(O(결과≤limit)).
    // 같은 이유로 nextCursor/hasMore 산정도 필터 *후* 행 기준으로 한다.
    const visibleSet = new Set(visibleIds);
    const filtered = fetched.filter((r) => visibleSet.has(r.channelId));

    const hasMore = filtered.length > args.limit;
    const rows = filtered.slice(0, args.limit);
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

  /**
   * S30 (FR-S06 / FR-S10): search() 결과에 전/후 컨텍스트 1메시지 + 스레드
   * 루트 excerpt 를 붙입니다.
   *
   * 권한 재검증(★ FR-S06): 컨텍스트로 끌어올 직전/직후 메시지는 *결과 메시지와
   * 같은 채널* 의 인접 메시지입니다. 그 채널이 요청자의 가시 집합 안인지 응답
   * 직전에 다시 확인합니다(visibleChannelIds 스냅샷을 search() 와 동일하게
   * 재사용). 채널 권한이 없으면 본문을 마스킹("[접근 불가 메시지]")하고
   * masked=true 로 내려보냅니다. (단일-레벨 스레드라 답글의 channelId 는 루트
   * 채널과 동일 — 채널 가시성 = 루트 채널 가시성.)
   *
   * 스레드(FR-S10): parentMessageId 가 있으면 inThread=true + 루트 메시지
   * 본문 excerpt 를 붙입니다. threadLocked 여부는 검색 포함에 영향을 주지
   * 않습니다(채널 권한이 있으면 잠긴 스레드 답글도 포함).
   */
  async searchWithContext(args: {
    query: string;
    workspaceId: string;
    userId: string;
    channelId?: string;
    senderId?: string;
    since?: Date;
    until?: Date;
    hasAttachment?: boolean;
    sort?: SearchSort;
    cursor?: string;
    limit: number;
    now?: Date;
  }): Promise<{ results: SearchResultRow[]; nextCursor: string | null }> {
    const base = await this.search(args);
    if (base.results.length === 0) return base;

    // 컨텍스트 권한 재검증의 단일 출처: search() 와 동일한 가시 집합 스냅샷.
    const visibleIds = new Set(await this.visibleChannelIds(args.workspaceId, args.userId));

    const enriched = await Promise.all(
      base.results.map(async (r) => {
        const [before, after, threadRootExcerpt] = await Promise.all([
          this.neighborMessage(r.channelId, r.createdAt, r.messageId, 'before', visibleIds),
          this.neighborMessage(r.channelId, r.createdAt, r.messageId, 'after', visibleIds),
          this.threadRootExcerpt(r.messageId, visibleIds),
        ]);
        return {
          ...r,
          contextBefore: before,
          contextAfter: after,
          inThread: threadRootExcerpt.inThread,
          threadRootExcerpt: threadRootExcerpt.excerpt,
        };
      }),
    );
    return { results: enriched, nextCursor: base.nextCursor };
  }

  /**
   * S30 (FR-S06): 결과 메시지의 직전/직후 메시지 1건을 같은 채널에서 가져옵니다.
   * 정렬 키는 (createdAt, id) — search() / 히스토리와 동일 tie-break.
   *
   * S30 fix-forward (BLOCKER 보안 A1): 채널 가시성 검사를 **쿼리 이전**에 수행해,
   * visibleIds 밖이면(쿼리 직후 ACL flip 등) DB 를 조회하지 않고 식별정보가 0 인
   * placeholder(messageId/createdAt/senderName/text 모두 null + masked:true)를
   * 즉시 반환합니다. 종전엔 쿼리 후 본문만 가렸으나 인접 메시지의 PK·정확한
   * 시각이 그대로 누출됐습니다. 정상 동작에선 컨텍스트 채널 == 결과 채널이라
   * 항상 가시이므로 이 분기는 ACL flip edge 방어용입니다(이제 누출 0).
   */
  private async neighborMessage(
    channelId: string,
    pivotCreatedAt: string,
    pivotId: string,
    direction: 'before' | 'after',
    visibleIds: ReadonlySet<string>,
  ): Promise<SearchContextMessageRow | null> {
    // ★ 권한 재검증을 쿼리 이전에 — 불가시 채널이면 조회 없이 식별정보 0 placeholder.
    if (!visibleIds.has(channelId)) {
      return { messageId: null, senderName: null, text: null, createdAt: null, masked: true };
    }
    const pivot = new Date(pivotCreatedAt);
    const where: Prisma.MessageWhereInput =
      direction === 'before'
        ? {
            channelId,
            deletedAt: null,
            OR: [{ createdAt: { lt: pivot } }, { createdAt: pivot, id: { lt: pivotId } }],
          }
        : {
            channelId,
            deletedAt: null,
            OR: [{ createdAt: { gt: pivot } }, { createdAt: pivot, id: { gt: pivotId } }],
          };
    const neighbor = await this.prisma.message.findFirst({
      where,
      orderBy:
        direction === 'before'
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        contentPlain: true,
        createdAt: true,
        author: { select: { username: true } },
      },
    });
    if (!neighbor) return null;
    // 채널 가시성은 위에서 이미 보장되므로 여기서는 항상 masked:false 로 모든
    // 필드를 채워 내려보냅니다(A1: 가시 채널이면 누출 없이 전부 공개).
    return {
      messageId: neighbor.id,
      senderName: neighbor.author.username,
      text: escapeHtml(truncatePlain(neighbor.contentPlain)),
      createdAt: neighbor.createdAt.toISOString(),
      masked: false,
    };
  }

  /**
   * S30 (FR-S10): 결과가 스레드 답글이면 루트 메시지 본문 excerpt 를 돌려줍니다.
   * 루트가 soft-delete 되었으면 본문을 비웁니다(inThread 는 유지).
   *
   * S30 fix-forward (HIGH 보안 A2): 종전엔 "답글 channelId == 루트 channelId"
   * 가정에만 의존해 루트 채널 가시성을 명시적으로 검증하지 않았습니다. 데이터
   * 이상이나 멀티레벨 스레드 확장 시 권한 없는 채널의 루트 본문이 누출될 수
   * 있는 시한폭탄이라, 호출부가 계산한 visibleIds 를 받아 루트 채널이 가시
   * 집합 밖이면 excerpt 를 비웁니다(inThread 는 유지).
   */
  private async threadRootExcerpt(
    messageId: string,
    visibleIds: ReadonlySet<string>,
  ): Promise<{ inThread: boolean; excerpt: string | null }> {
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { parentMessageId: true },
    });
    if (!msg?.parentMessageId) return { inThread: false, excerpt: null };
    const root = await this.prisma.message.findUnique({
      where: { id: msg.parentMessageId },
      select: { contentPlain: true, deletedAt: true, channelId: true },
    });
    // 루트가 없거나 삭제됐거나 루트 채널이 가시 집합 밖이면 본문을 비웁니다.
    if (!root || root.deletedAt || !visibleIds.has(root.channelId)) {
      return { inThread: true, excerpt: null };
    }
    return { inThread: true, excerpt: escapeHtml(truncatePlain(root.contentPlain)) };
  }

  /**
   * S30 (FR-S07): 최근 검색어 조회 — Redis `search:recent:{userId}` LIST.
   * LPUSH 로 newest-first. 빈 쿼리/공백은 저장하지 않습니다.
   */
  async recentSearches(userId: string, limit = RECENT_SEARCH_MAX): Promise<string[]> {
    const cap = Math.max(1, Math.min(RECENT_SEARCH_MAX, limit));
    const raw = await this.redis.lrange(recentSearchKey(userId), 0, cap - 1);
    return raw;
  }

  /**
   * S30 (FR-S07): 최근 검색어 기록 — 중복 제거(LREM) 후 LPUSH, 상한 N 으로
   * LTRIM. 30일 TTL(휘발성 UX 데이터). 공백/빈 쿼리는 no-op.
   */
  async pushRecentSearch(userId: string, query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > RECENT_SEARCH_VALUE_MAX) return;
    const key = recentSearchKey(userId);
    await this.redis.lrem(key, 0, trimmed); // 중복 제거(전체 매치 0 = all)
    await this.redis.lpush(key, trimmed);
    await this.redis.ltrim(key, 0, RECENT_SEARCH_MAX - 1);
    await this.redis.expire(key, RECENT_SEARCH_TTL_SEC);
  }

  /**
   * task-046 iter3 (J1): typing-time suggestions — autocomplete prefix.
   *
   * 사용자가 검색어 typing 중에 빠른 후보 제안을 위해 호출. 워크스페이스
   * scope 안의 channel 이름 + 멤버 username 을 prefix-match (ILIKE) 로
   * 가져옴. 메시지 본문 검색 (search()) 과 별개의 lightweight path.
   *
   * 결과는 채널 + 사용자 통합 list, 합 max 10. ranking 은 prefix exact
   * 우선 → 길이 순 (짧은 것 먼저).
   */
  async suggest(args: {
    workspaceId: string;
    userId: string;
    prefix: string;
    limit?: number;
  }): Promise<{
    channels: Array<{ id: string; name: string }>;
    users: Array<{ id: string; username: string }>;
  }> {
    const p = args.prefix.trim();
    if (p.length === 0) return { channels: [], users: [] };
    const cap = Math.max(1, Math.min(20, args.limit ?? 5));

    const visibleIds = await this.visibleChannelIds(args.workspaceId, args.userId);
    if (visibleIds.length === 0) return { channels: [], users: [] };

    const channels = await this.prisma.channel.findMany({
      where: {
        id: { in: visibleIds },
        deletedAt: null,
        name: { startsWith: p, mode: 'insensitive' },
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }],
      take: cap,
    });

    // 멤버는 워크스페이스 scope 의 사용자 — workspaceMember + User join.
    const memberRows = await this.prisma.workspaceMember.findMany({
      where: {
        workspaceId: args.workspaceId,
        user: { username: { startsWith: p, mode: 'insensitive' } },
      },
      include: { user: { select: { id: true, username: true } } },
      orderBy: { user: { username: 'asc' } },
      take: cap,
    });

    return {
      channels: channels.map((c) => ({ id: c.id, name: c.name })),
      users: memberRows.map((m) => ({ id: m.user.id, username: m.user.username })),
    };
  }
}

// ── S30 (FR-S06 / FR-S07) — 모듈 헬퍼 ─────────────────────────────────────────

/** 컨텍스트 본문 truncate 길이(문자). 카드에서 최대 3줄 표시 전 1차 절단. */
const CONTEXT_EXCERPT_MAX = 200;

/** 최근 검색 상한 N(LTRIM 인덱스). */
const RECENT_SEARCH_MAX = 8;
/** 단일 검색어 길이 상한(거대 입력 저장 방지). */
const RECENT_SEARCH_VALUE_MAX = 200;
/** 최근 검색 TTL — 30일(휘발성 UX 데이터). */
const RECENT_SEARCH_TTL_SEC = 60 * 60 * 24 * 30;

function recentSearchKey(userId: string): string {
  return `search:recent:${userId}`;
}

/**
 * 컨텍스트 본문은 plain text 이므로 HTML 특수문자만 escape 해서 내려보냅니다
 * (snippet 과 달리 <mark> 하이라이트 없음). 프런트는 escape 된 텍스트 그대로
 * 렌더(이중 escape 회피).
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 단일 줄 컨텍스트로 표시하기 위해 개행을 공백으로 접고 길이를 절단합니다. */
function truncatePlain(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= CONTEXT_EXCERPT_MAX) return oneLine;
  return `${oneLine.slice(0, CONTEXT_EXCERPT_MAX)}…`;
}
