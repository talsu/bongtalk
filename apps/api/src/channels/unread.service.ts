import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import type { ReadStateUpdatedPayload } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { readBitVisibleSql, mentionMatchSql } from '../common/acl/read-visibility.sql';

export interface UnreadChannelSummary {
  channelId: string;
  unreadCount: number;
  hasMention: boolean;
  mentionCount: number;
  lastMessageAt: string | null;
}

export interface UnreadWorkspaceTotal {
  workspaceId: string;
  unreadCount: number;
  hasMention: boolean;
  mentionCount: number;
}

interface CachedChannelEntry {
  unreadCount: number;
  mentionCount: number;
}

/**
 * S24 (FR-RS-18): mark-all-read 직전 채널별 커서. 복원 시 그대로 되돌린다(後進
 * 허용). row 가 없던(전체 미읽) 채널은 둘 다 null 로 담는다.
 */
interface SnapshotCursor {
  lastReadMessageId: string | null;
  /** ISO 문자열(JSON 직렬화). 복원 시 timestamptz 로 캐스팅. */
  lastReadMessageCreatedAt: string | null;
}

/** S24 (FR-RS-18): read-all 응답 — 스냅샷 id + fan-out payload 들. */
export interface MarkAllReadResult {
  snapshotId: string;
  payloads: ReadStateUpdatedPayload[];
}

/**
 * S21 (D09 · FR-RS): 읽음상태 코어. summarize/totals/unreadCountFor 가
 * (createdAt, id) 튜플 커서 공식(S11)을 공유하고, 비공개 채널 가시성 판정을
 * `PermissionMatrix.effective` 의 5단계 fold 와 동일 우선순위로 정렬한다.
 *
 * ── (createdAt, id) 튜플 커서 (S11 · FR-RS-03) ──
 * Message.id 는 `@default(uuid())` 랜덤 UUID(비정렬)라 `id >` 문자열 비교가
 * 메시지 순서와 무관하다. 따라서 읽음/미읽음 판정은 메시지 커서 페이지네이션
 * (messages.service)과 동일하게 (createdAt, id) 튜플로 비교한다:
 *
 *   unread ⇔ (m.createdAt, m.id) > (rs.lastReadMessageCreatedAt,
 *                                   rs.lastReadMessageId)
 *
 * read-state row 가 없거나 커서가 NULL 이면 LEFT JOIN 이 NULL 을 만들고
 * 튜플 비교가 "전부 미읽음" 으로 평가된다(새로 가입한 채널 UX 일치). 자기
 * 메시지도 미읽음으로 집계한다(FR-RS-03, senderId 제외 없음).
 *
 * ── 비공개 채널 가시성 = 5단계 fold READ 비트 (S21 · FR-RS-01/ACL) ──
 * S14 `PermissionMatrix.effective` 는 단계별 누적(base→roleAllow→roleDeny→
 * userAllow→userDeny)으로 "개인 ALLOW > 역할 DENY", "개인 DENY > 모든 ALLOW"
 * 경계를 표현한다. 종전 unread SQL 은 `(bit_or(allow) & ~bit_or(deny)) & 1`
 * 2단계 union 이라 그 경계를 깨뜨렸다(IDOR 누설 위험). 본 서비스는 USER/ROLE
 * 오버라이드를 principalType 별로 나눠 bit_or 한 뒤, READ 비트(0x1)에 대해
 * 다음 5단계 fold 를 SQL 에서 재현한다:
 *
 *   base      = isPrivate ? (hasExplicitRead ? READ : 0) : READ
 *   read_bit  = (((base | roleAllowREAD) & ~roleDenyREAD) | userAllowREAD)
 *                                                         & ~userDenyREAD
 *   visible   = (read_bit <> 0)
 *
 * hasExplicitRead = ((userAllow | roleAllow) & READ) — S15 hasExplicitRead 정합:
 * 비공개 채널은 READ 비트가 명시적으로 ALLOW 돼야 base 가 열린다(비-READ
 * grant 가 가시성을 누설하지 않음).
 *
 * S21 fix-forward (MINOR-E): OWNER baseline 도 5단계 fold 를 통과시킨다(종전
 * `role='OWNER'` 무조건 가시 단락 제거). PermissionMatrix.effective 가 OWNER
 * 에도 명시 DENY 를 존중하므로(0xFF baseline 위에 userDeny/roleDeny AND-NOT)
 * unread 가시성도 동일 공식을 따라야 정합한다. OWNER 는 ROLE_BASELINE 이 READ
 * 비트를 포함하므로 명시 DENY 가 없으면 자동으로 보인다.
 *
 * ── ACL fold 단일 출처 (S21 fix-forward · CRITICAL-C/MINOR-E) ──
 * `readBitVisibleSql()` 헬퍼가 5단계 fold READ 비트 표현식을 단일 출처로 두고,
 * summarize 와 summarizeWorkspaceTotals 가 동일 공식을 참조한다. totals 는
 * 종전 상관 서브쿼리(채널마다 ovr 재집계)를 overrides CTE 로 한 번 집계 후
 * join 으로 교체해 단일 round-trip + 동일 SQL 패턴을 보장한다.
 *
 * ── 멘션 집계 (S21 · FR-RS-16 + fix-forward SERIOUS-F) ──
 * hasMention/mentionCount 는 message_mentions JSONB 에서 다음을 모두 본다:
 *   - `users` 배열에 본인 userId 포함(직접 멘션)
 *   - `everyone` / `here` / `channel`(범위 멘션) — 저장 시 gate.ts 가 권한
 *     없는 특수멘션을 false 로 다운그레이드하므로, 권한 없는 특수멘션은
 *     이미 집계에서 빠진다(S18 정합). mentionCount = 위 조건을 만족하는 미읽음
 *     메시지 수. 모든 조건은 `@>` JSONB containment 로 표현해 GIN
 *     `Message_mentions_gin_idx` 를 활용한다(종전 `->>'everyone'` 추출은
 *     인덱스 미활용 — fix-forward SERIOUS-F).
 *
 * ── Redis 캐시 + stampede 락 (S21 · FR-RS-14 + fix-forward CRITICAL-B) ──
 * cachedWorkspaceTotal 은 `unread:{ws}:{user}` Hash(TTL 2h)를 read-through
 * 캐시로 쓰고, 미스 시 `unread:lock:{ws}:{user}` SET NX PX 뮤텍스로 집계 폭주를
 * 막는다. 락을 못 잡은 동시 호출자는 무거운 SQL 을 바로 치지 않고 짧게 대기 후
 * 캐시를 재조회한다(선점자가 채운 결과를 공유). 락 토큰은 per-call 랜덤이라
 * compare-and-del 로만 해제(타 홀더 락 삭제 방지). ACK / 새 메시지 / 멤버 변경
 * 시 무효화한다.
 */
@Injectable()
export class UnreadService {
  private readonly logger = new Logger(UnreadService.name);
  /** FR-RS-14: 캐시 TTL 2시간(ms). */
  private static readonly CACHE_TTL_MS = 2 * 60 * 60 * 1000;
  /** CRITICAL-B: 락 미선점 시 캐시 재조회 대기 — 50ms × 최대 3회. */
  private static readonly LOCK_WAIT_MS = 50;
  private static readonly LOCK_WAIT_ATTEMPTS = 3;
  /** fenced unlock: 내 토큰일 때만 DEL(타 홀더 락 보호). */
  private static readonly UNLOCK_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  // S47 fix-forward (BLOCKER-4): 5단계 fold READ 비트 가시성 + 멘션 판정 술어는
  // `../common/acl/read-visibility.sql` 로 추출돼 rail(본 서비스)·badges·ACK 가
  // 동일 truth-source 를 공유한다(종전 private readBitVisibleSql/mentionMatchSql 은
  // 그 단일 출처로 대체). summarize/totals/markAllRead 가 import 한 함수를 호출한다.

  async summarize(workspaceId: string, userId: string): Promise<UnreadChannelSummary[]> {
    const visible = readBitVisibleSql({
      isPrivate: Prisma.sql`c."isPrivate"`,
      roleAllow: Prisma.sql`o.role_allow`,
      roleDeny: Prisma.sql`o.role_deny`,
      userAllow: Prisma.sql`o.user_allow`,
      userDeny: Prisma.sql`o.user_deny`,
    });
    const mentionMatch = mentionMatchSql(Prisma.sql`msg`, Prisma.sql`${userId}::text`);

    const rows = await this.prisma.$queryRaw<
      Array<{
        channel_id: string;
        unread_count: bigint | number;
        has_mention: boolean;
        mention_count: bigint | number;
        last_message_at: Date | null;
      }>
    >(Prisma.sql`
      WITH me AS (
        SELECT role
          FROM "WorkspaceMember"
         WHERE "workspaceId" = ${workspaceId}::uuid
           AND "userId" = ${userId}::uuid
      ),
      -- S21 ACL: principalType 별로 ALLOW/DENY 를 나눠 bit_or. readBitVisibleSql
      -- 의 5단계 fold 가 이 컬럼들을 참조한다(PermissionMatrix.effective 정합).
      overrides AS (
        SELECT
          cpo."channelId",
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_deny,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_deny
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
           -- MINOR-E: OWNER 단락 없음 — OWNER baseline 도 fold 통과(명시 DENY 존중).
           AND ${visible}
      )
      SELECT
        c.id AS channel_id,
        COALESCE(m.count_after, 0)      AS unread_count,
        COALESCE(m.has_mention, false)  AS has_mention,
        COALESCE(m.mention_count, 0)    AS mention_count,
        m.latest_at                     AS last_message_at
      FROM visible_channels c
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = ${userId}::uuid
       AND rs."channelId" = c.id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS count_after,
          bool_or(${mentionMatch}) AS has_mention,
          count(*) FILTER (WHERE ${mentionMatch}) AS mention_count,
          max(msg."createdAt") AS latest_at
        FROM "Message" msg
        WHERE msg."channelId" = c.id
          AND msg."deletedAt" IS NULL
          -- S36 fix-forward (BLOCKER-1 · FR-TH-11): 채널 unread/멘션은 roots-only.
          -- messages.service rawList(채널 목록 read-path)와 동일 술어로, 스레드
          -- 답글(parentMessageId 보유·비-broadcast)을 채널 배지 집계에서 제외한다.
          -- broadcast 행(isBroadcast=true)은 채널 타임라인에 노출되므로 포함(+1).
          -- Message_channel_roots_idx partial index 와 정합(perf 회귀 없음).
          AND (msg."parentMessageId" IS NULL OR msg."isBroadcast" = true)
          AND (
            rs."lastReadMessageCreatedAt" IS NULL
            OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
          )
      ) m ON true
      ORDER BY c."createdAt" ASC
    `);

    return rows.map((r) => ({
      channelId: r.channel_id,
      unreadCount: Number(r.unread_count ?? 0),
      hasMention: r.has_mention === true,
      mentionCount: Number(r.mention_count ?? 0),
      lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
    }));
  }

  /**
   * S21 (FR-RS-16): workspace-level unread aggregate. 같은 (createdAt, id) 튜플
   * 공식 + 5단계 fold ACL 을 적용하고, unread 0 인 워크스페이스도 한 줄 반환한다
   * (레일 렌더 — zero-entry undefined 회귀 방지). 멤버십이 정본이라 LEFT JOIN.
   *
   * S21 fix-forward (CRITICAL-C): 종전 비공개 가시성 상관 서브쿼리(채널마다
   * ovr 재집계)를 overrides CTE 로 한 번 집계 후 join 으로 교체 — 단일 round-trip
   * + summarize 와 동일 SQL 패턴. ACL fold 는 readBitVisibleSql 단일 출처.
   * (MINOR-E): OWNER 단락 제거 — OWNER baseline 도 fold 통과(명시 DENY 존중).
   */
  async summarizeWorkspaceTotals(userId: string): Promise<UnreadWorkspaceTotal[]> {
    // totals 는 channel_overrides CTE 에서 채널+오버라이드를 별칭 `c` 로 노출하므로
    // fold 가 c.* 컬럼을 참조한다(summarize 의 c/o 분리와 별개 바인딩, 공식은 동일).
    const visible = readBitVisibleSql({
      isPrivate: Prisma.sql`c."isPrivate"`,
      roleAllow: Prisma.sql`c.role_allow`,
      roleDeny: Prisma.sql`c.role_deny`,
      userAllow: Prisma.sql`c.user_allow`,
      userDeny: Prisma.sql`c.user_deny`,
    });
    const mentionMatch = mentionMatchSql(Prisma.sql`msg`, Prisma.sql`vc."userId"::text`);

    const rows = await this.prisma.$queryRaw<
      Array<{
        workspace_id: string;
        unread_count: bigint | number;
        has_mention: boolean;
        mention_count: bigint | number;
      }>
    >(Prisma.sql`
      WITH my_memberships AS (
        SELECT wm."workspaceId", wm."userId", wm.role
          FROM "WorkspaceMember" wm
         WHERE wm."userId" = ${userId}::uuid
      ),
      -- CRITICAL-C: 본인이 멤버인 워크스페이스의 채널 오버라이드를 채널 × (USER
      -- 본인 | ROLE 본인역할) 기준으로 한 번에 bit_or. 채널마다 재집계하던
      -- 상관 서브쿼리를 단일 CTE join 으로 대체(summarize 와 동일 패턴).
      overrides AS (
        SELECT
          cpo."channelId",
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_deny,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_deny
        FROM "ChannelPermissionOverride" cpo
        JOIN "Channel" cc ON cc.id = cpo."channelId"
        JOIN my_memberships mm ON mm."workspaceId" = cc."workspaceId"
        WHERE (
          (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
          OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = mm.role::text)
        )
        GROUP BY cpo."channelId"
      ),
      -- 채널 + 본인 적용 오버라이드를 미리 결합(공개 채널은 overrides row 가 없어
      -- o.* NULL → COALESCE 로 0 처리). 가시성 판정이 이 결합 relation 의 ON 절을
      -- 단일 출처(readBitVisibleSql)로 참조하게 한다.
      channel_overrides AS (
        SELECT c.id, c."workspaceId", c."isPrivate",
               o.role_allow, o.role_deny, o.user_allow, o.user_deny
          FROM "Channel" c
          LEFT JOIN overrides o ON o."channelId" = c.id
         WHERE c."deletedAt" IS NULL
      ),
      -- CRITICAL-C: 가시성 판정을 Channel LEFT JOIN 의 ON 절에 박아 비가시 채널은
      -- join 되지 않되(channel_id=NULL → 메시지 LATERAL 스킵), 멤버십 row 자체는
      -- LEFT JOIN 이라 항상 유지된다. zero-channel 워크스페이스와 "채널은 있으나
      -- 전부 비가시" 워크스페이스 둘 다 한 줄(unread 0)을 반환한다(zero-entry
      -- 회귀 방지 + OWNER DENY 정합).
      visible_channels AS (
        SELECT wm."workspaceId", wm."userId", c.id AS channel_id
          FROM my_memberships wm
          LEFT JOIN channel_overrides c
            ON c."workspaceId" = wm."workspaceId"
           AND (${visible})
      )
      SELECT
        vc."workspaceId"                        AS workspace_id,
        COALESCE(SUM(u.count_after), 0)         AS unread_count,
        COALESCE(bool_or(u.has_mention), false) AS has_mention,
        COALESCE(SUM(u.mention_count), 0)       AS mention_count
      FROM visible_channels vc
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = vc."userId"
       AND rs."channelId" = vc.channel_id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS count_after,
          bool_or(${mentionMatch}) AS has_mention,
          count(*) FILTER (WHERE ${mentionMatch}) AS mention_count
        FROM "Message" msg
        WHERE msg."channelId" = vc.channel_id
          AND msg."deletedAt" IS NULL
          -- S36 fix-forward (BLOCKER-1 · FR-TH-11): 워크스페이스 totals 도 roots-only
          -- (summarize 와 동일 술어) — 답글이 워크스페이스 합산 배지에 누수되지 않는다.
          AND (msg."parentMessageId" IS NULL OR msg."isBroadcast" = true)
          AND (
            rs."lastReadMessageCreatedAt" IS NULL
            OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
          )
      ) u ON true
      GROUP BY vc."workspaceId"
      ORDER BY vc."workspaceId" ASC
    `);

    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      unreadCount: Number(r.unread_count ?? 0),
      hasMention: r.has_mention === true,
      mentionCount: Number(r.mention_count ?? 0),
    }));
  }

  /**
   * S11 (FR-RS-03): single-channel unread recount with the same tuple cursor
   * formula. Used by `ackRead` for the `read_state:updated` payload. No ACL
   * filter — the ack path already passed ChannelAccessGuard.
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
           -- S36 fix-forward (BLOCKER-1 · FR-TH-11): single-channel recount 도
           -- roots-only — ackRead 의 read_state:updated payload unreadCount 가
           -- 답글을 산입하지 않게 한다(summarize 와 동일 술어).
           AND (msg."parentMessageId" IS NULL OR msg."isBroadcast" = true)
           AND (
             rs."lastReadMessageCreatedAt" IS NULL
             OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
           )
      ), 0) AS unread_count
    `;
    return Number(rows[0]?.unread_count ?? 0);
  }

  /**
   * S21 (FR-RS-16): single-channel mention recount with the same tuple cursor.
   * mentionCount = 미읽음 메시지 중 본인 대상 멘션(직접 + everyone/here/channel)
   * 수. ACK 시 0 으로 수렴(커서 전진 → 미읽음 멘션 메시지가 사라짐). 멘션 판정은
   * summarize 와 동일하게 mentionMatchSql 단일 출처(GIN containment).
   */
  async mentionCountFor(userId: string, channelId: string): Promise<number> {
    const mentionMatch = mentionMatchSql(Prisma.sql`msg`, Prisma.sql`${userId}::text`);
    const rows = await this.prisma.$queryRaw<Array<{ mention_count: bigint | number }>>(Prisma.sql`
      SELECT COALESCE((
        SELECT count(*)
          FROM "Message" msg
          LEFT JOIN "UserChannelReadState" rs
            ON rs."userId" = ${userId}::uuid
           AND rs."channelId" = ${channelId}::uuid
         WHERE msg."channelId" = ${channelId}::uuid
           AND msg."deletedAt" IS NULL
           -- S36 fix-forward (BLOCKER-1 · FR-TH-11): 채널 멘션 카운트도 roots-only —
           -- 스레드 답글 내 @멘션이 채널 멘션 배지에 산입되지 않게 막는다.
           AND (msg."parentMessageId" IS NULL OR msg."isBroadcast" = true)
           AND ${mentionMatch}
           AND (
             rs."lastReadMessageCreatedAt" IS NULL
             OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
           )
      ), 0) AS mention_count
    `);
    return Number(rows[0]?.mention_count ?? 0);
  }

  /**
   * S11 (FR-RS-01/17): ack a read up to `lastReadMessageId`.
   *
   *  1. validate the message belongs to `channelId` (else 404).
   *  2. monotonic (createdAt, id) tuple upsert — advance ONLY when the new
   *     tuple is strictly greater than the stored one (cursor 퇴행 방지).
   *  3. recompute unread/mention count with the tuple formula.
   *  4. invalidate the workspace Redis cache so totals re-aggregate.
   *  5. return the `read_state:updated` payload (workspaceId 포함) for the
   *     caller to emit to `user:{userId}` (all sessions).
   *
   * S21 fix-forward (NIT-G): 호출자가 workspaceId 를 알면(HTTP /ack 컨트롤러는
   * route param 으로 보유) 인자로 받아 (a) 페이로드에 실어 dispatcher 가 keyed
   * 쿼리를 직접 patch 하게 하고, (b) 캐시 무효화 시 channel→workspaceId SELECT 를
   * 생략한다. WS channel:read / markRead 등 workspaceId 미보유 호출은 종전대로
   * 채널 조회로 폴백한다.
   *
   * The upsert is monotonic via a conditional UPDATE guarded on the stored
   * tuple. When the incoming ack is older (퇴행) the UPDATE matches zero rows
   * and the stored cursor is left intact — but the recount + payload still
   * reflect the current (unchanged) cursor so a no-op ack is idempotent
   * (FR-RS-17: 멀티세션 동시 ACK 가 後進하지 않는다).
   */
  async ackRead(args: {
    userId: string;
    channelId: string;
    lastReadMessageId: string;
    workspaceId?: string;
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

    const [unreadCount, mentionCount] = await Promise.all([
      this.unreadCountFor(userId, channelId),
      this.mentionCountFor(userId, channelId),
    ]);

    // FR-RS-14: ACK 시 캐시 무효화 — 다음 totals 집계가 새 커서를 반영한다.
    // NIT-G: workspaceId 보유 시 channel→workspaceId SELECT 생략.
    let workspaceId = args.workspaceId ?? null;
    if (workspaceId) {
      await this.invalidateWorkspaceUserCache(workspaceId, userId);
    } else {
      workspaceId = await this.invalidateUserCacheForChannel(userId, channelId);
    }

    return {
      channelId,
      workspaceId,
      lastReadMessageId: current?.lastReadMessageId ?? lastReadMessageId,
      unreadCount,
      mentionCount,
    };
  }

  /**
   * S24 (FR-RS-08): 수동 미읽 표시(monotonic 후진). 사용자가 메시지 hover toolbar
   * 에서 "미읽으로 표시" 한 메시지(messageId)의 **직전** 메시지로 lastReadMessageId
   * 를 되돌린다(직전이 없으면 null = 전체 미읽).
   *
   * ★ 의도적 후진 — S21 monotonic guard 우회 지점.
   * ackRead 의 upsert 는 `WHERE stored < EXCLUDED` 가드로 後進을 막지만, 본 메서드는
   * **그 가드 없이** ChannelReadState 를 직접 UPDATE/upsert 한다(後進 허용). 이것이
   * markUnread 의 비-monotonic 경로이며, undoMarkAllRead 의 복원도 동일 경로를 쓴다.
   *
   *  1. messageId 가 채널 소속인지 검증(아니면 404).
   *  2. 그 메시지 직전(= (createdAt, id) 튜플이 strictly 작은 최신) 메시지를 찾는다.
   *  3. 직전이 있으면 그 커서로, 없으면 NULL 커서(전체 미읽)로 **가드 없이** 설정.
   *  4. unread/mention 재계산 + 캐시 무효화 + read_state:updated payload 반환.
   */
  async markUnread(args: {
    userId: string;
    channelId: string;
    messageId: string;
    workspaceId?: string;
  }): Promise<ReadStateUpdatedPayload> {
    const { userId, channelId, messageId } = args;

    const target = await this.prisma.message.findFirst({
      where: { id: messageId, channelId, deletedAt: null },
      select: { id: true, createdAt: true },
    });
    if (!target) {
      throw new DomainError(
        ErrorCode.MESSAGE_NOT_FOUND,
        'messageId does not belong to this channel',
      );
    }

    // 직전 메시지 = (createdAt, id) 튜플이 target 보다 strictly 작은 것 중 최신.
    // 같은 커서 공식(messages.service / unread)과 정합한 역방향 비교.
    const prev = await this.prisma.message.findFirst({
      where: {
        channelId,
        deletedAt: null,
        OR: [
          { createdAt: { lt: target.createdAt } },
          { AND: [{ createdAt: target.createdAt }, { id: { lt: target.id } }] },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });

    await this.setCursorBackward(userId, channelId, {
      lastReadMessageId: prev?.id ?? null,
      lastReadMessageCreatedAt: prev?.createdAt ?? null,
    });

    const [unreadCount, mentionCount] = await Promise.all([
      this.unreadCountFor(userId, channelId),
      this.mentionCountFor(userId, channelId),
    ]);

    let workspaceId = args.workspaceId ?? null;
    if (workspaceId) {
      await this.invalidateWorkspaceUserCache(workspaceId, userId);
    } else {
      workspaceId = await this.invalidateUserCacheForChannel(userId, channelId);
    }

    return {
      channelId,
      workspaceId,
      lastReadMessageId: prev?.id ?? null,
      unreadCount,
      mentionCount,
    };
  }

  /**
   * S24 (FR-RS-08/18): monotonic guard 없는 커서 setter(後進 허용). markUnread 와
   * undoMarkAllRead 복원이 공유하는 단일 출처. ackRead 의 가드 있는 upsert 와 달리
   * 무조건 EXCLUDED 로 덮어쓴다(stored 튜플과의 비교 WHERE 없음). null 커서는 row 가
   * 없으면 lastReadAt 만 보장하는 INSERT, 있으면 커서 컬럼을 NULL 로 되돌린다.
   */
  private async setCursorBackward(
    userId: string,
    channelId: string,
    cursor: { lastReadMessageId: string | null; lastReadMessageCreatedAt: Date | null },
  ): Promise<void> {
    const { lastReadMessageId, lastReadMessageCreatedAt } = cursor;
    const at = lastReadMessageCreatedAt ?? new Date();
    await this.prisma.$executeRaw`
      INSERT INTO "UserChannelReadState"
        ("userId", "channelId", "lastReadEventId", "lastReadAt",
         "lastReadMessageId", "lastReadMessageCreatedAt", "updatedAt")
      VALUES
        (${userId}::uuid, ${channelId}::uuid, ${randomUUID()}::uuid, ${at},
         ${lastReadMessageId}::uuid, ${lastReadMessageCreatedAt}, now())
      ON CONFLICT ("userId", "channelId") DO UPDATE
        SET "lastReadMessageId" = ${lastReadMessageId}::uuid,
            "lastReadMessageCreatedAt" = ${lastReadMessageCreatedAt},
            "lastReadAt" = ${at},
            "updatedAt" = now()
    `;
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
    await this.invalidateUserCacheForChannel(userId, channelId);
    return { readAt };
  }

  /**
   * S24 fix-forward (reviewer MAJOR #3 · FR-RS-09): 채널을 최신까지 읽음 처리하고
   * **read_state:updated payload 를 반환**한다(emit 경로). 종전 markRead 는 payload
   * 를 버려 호출자가 emit 할 수 없었고, 그래서 채널 컨텍스트 메뉴 "읽음으로 표시"
   * / Unreads "읽음 처리" 가 멀티세션에서 desync 됐다. 본 메서드는 ackRead(이미
   * emit-ready payload 반환) 를 재사용해 컨트롤러가 user 룸으로 fan-out 하게 한다.
   * 채널에 메시지가 없으면 커서 전진이 불필요하므로 read-state 만 보장하고 null
   * 을 반환한다(emit 없음 — 미읽이 애초에 0).
   */
  async markChannelReadToLatest(
    userId: string,
    channelId: string,
    workspaceId: string,
  ): Promise<ReadStateUpdatedPayload | null> {
    const latest = await this.prisma.message.findFirst({
      where: { channelId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!latest) {
      await this.markRead(userId, channelId);
      return null;
    }
    return this.ackRead({ userId, channelId, lastReadMessageId: latest.id, workspaceId });
  }

  /**
   * S23 fix-forward (MAJOR): 워크스페이스 전체 읽음(Shift+Esc).
   *
   * 종전 구현은 채널마다 findFirst + ackRead(각 ~6 쿼리)를 순차 실행해 O(N)
   * 라운드트립이었고 트랜잭션이 없어 Shift+Esc 가 행(hang)하거나 부분 실패할 수
   * 있었다. 본 구현은 단일 set-based SQL 한 방으로 가시 채널들의
   * UserChannelReadState 를 각 채널의 최신 (createdAt, id) 튜플로 monotonic 하게
   * 전진시킨다(원자적 · 행 없음):
   *
   *  - 가시성(ACL)은 summarize 와 동일한 readBitVisibleSql 5단계 fold 를 재사용
   *    (overrides CTE → 단일 출처). 비공개/비멤버/명시 DENY 채널은 애초에
   *    visible_channels 에 들지 않는다.
   *  - 각 채널의 최신 메시지(latest CTE: DISTINCT ON 으로 (createdAt, id) 최대)를
   *    구해, INSERT … SELECT … ON CONFLICT DO UPDATE 의 monotonic guard(저장된
   *    튜플보다 strictly 큰 경우에만 전진)로 한 번에 upsert 한다. ackRead 와 동일
   *    한 guard 라 後進이 없고, 이미 읽은 채널은 UPDATE 가 0 행을 match 한다.
   *  - RETURNING 으로 실제 전진한 채널 + 새 커서만 받아 payload 를 만든다(unread/
   *    mention 은 최신까지 읽었으므로 0). 캐시는 워크스페이스 단위 1회 무효화.
   *
   * 반환한 payload 배열을 컨트롤러가 호출자의 user 룸으로 fan-out 한다(멀티세션
   * 배지 동기화). useMarkAllRead.onError 는 클라에서 summary invalidate 로 롤백.
   *
   * ── S24 개정 (FR-RS-18): snapshot + Undo ──
   * ── S24 fix-forward (reviewer MAJOR + perf): snapshot 원자성 ──
   * 종전은 (1) 별도 SELECT 스냅샷 → (2) persist → (3) advance 순서라 SELECT 와
   * advance 사이에 끼어든 동시 ACK 가 snapshot 보다 커서를 더 전진시켜 Undo 가
   * **과도 후진**(동시 ACK 가 읽은 메시지까지 미읽으로 되돌림)할 수 있었다.
   *
   * 본 구현은 advance 의 set-based UPDATE 가 **덮어쓰기 직전 old (lastReadMessageId,
   * lastReadMessageCreatedAt) 를 같은 statement(CTE)의 RETURNING 으로 캡처**해,
   * 그 반환값으로 스냅샷을 구성한다. snapshot == 실제 덮어쓴 값이므로 snapshot↔
   * advance 사이 race 가 구조적으로 사라진다(자연 정합). advance + persist 를
   * `$transaction` 으로 묶어 persist 실패 시 ACK 까지 롤백한다(스냅샷 없는 ACK 가
   * 남지 않음 = Undo 불가 상태 차단, 원자성 보장).
   *
   * 반환값에 snapshotId 를 실어 컨트롤러가 Undo 토스트에 전달한다.
   */
  async markAllRead(userId: string, workspaceId: string): Promise<MarkAllReadResult> {
    const snapshotId = randomUUID();

    // advance(RETURNING old) + DB persist 를 단일 트랜잭션으로 묶는다. RETURNING
    // 으로 받은 old 커서가 곧 스냅샷이라 snapshot↔advance race 가 없다. persist
    // 실패 시 트랜잭션 전체 롤백 → ACK 되돌림(스냅샷 없는 ACK 미잔류).
    const { payloads, snapshot } = await this.prisma.$transaction(async (tx) => {
      const advanced = await this.advanceAllVisible(tx, userId, workspaceId);
      const snap: Record<string, SnapshotCursor> = {};
      for (const a of advanced) {
        snap[a.channelId] = {
          lastReadMessageId: a.previousLastReadMessageId,
          lastReadMessageCreatedAt: a.previousLastReadMessageCreatedAt
            ? a.previousLastReadMessageCreatedAt.toISOString()
            : null,
        };
      }
      // DB durable 저장(트랜잭션 내). 실패 시 throw → 트랜잭션 롤백(ACK 되돌림).
      await this.persistSnapshotDb(tx, snapshotId, userId, workspaceId, snap);
      return {
        payloads: advanced.map((a) => a.payload),
        snapshot: snap,
      };
    });

    // Redis hot 저장(트랜잭션 밖 best-effort). DB durable 저장은 이미 커밋됐으므로
    // Redis 실패가 Undo 가능성을 깨지 않는다(loadSnapshot 이 DB 폴백). 전진 채널이
    // 0 개여도 빈 스냅샷을 저장해 Undo 호출이 404 가 아닌 no-op(0 복원)으로 수렴한다.
    await this.cacheSnapshotRedis(snapshotId, userId, workspaceId, snapshot);

    // FR-RS-14: 워크스페이스 단위 캐시 1회 무효화(채널별 무효화 불필요 — 같은
    // Hash 키이므로). 다음 totals/summary 집계가 새 커서를 반영한다.
    if (payloads.length > 0) {
      await this.invalidateWorkspaceUserCache(workspaceId, userId);
    }

    return { snapshotId, payloads };
  }

  /**
   * S24 fix-forward: 가시 채널을 각 최신 메시지까지 monotonic 전진하면서, 같은
   * statement 에서 **덮어쓰기 직전 old 커서를 RETURNING** 으로 캡처한다(snapshot
   * 원자성). 트랜잭션 클라이언트(tx)에서 실행해 persist 와 묶는다.
   *
   * old 캡처 방식: ON CONFLICT 의 RETURNING 은 새 값만 주므로, INSERT 대상
   * latest 와 기존 row 를 미리 LEFT JOIN 해 두고(prior CTE), UPDATE 가 실제로
   * 전진한 채널의 prior 커서를 결과에 함께 싣는다. 신규 INSERT(기존 row 없음)는
   * prior 가 NULL → 스냅샷도 NULL 커서(전체 미읽)로 복원돼 정합한다.
   */
  private async advanceAllVisible(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
  ): Promise<
    Array<{
      channelId: string;
      payload: ReadStateUpdatedPayload;
      previousLastReadMessageId: string | null;
      previousLastReadMessageCreatedAt: Date | null;
    }>
  > {
    const visible = readBitVisibleSql({
      isPrivate: Prisma.sql`c."isPrivate"`,
      roleAllow: Prisma.sql`o.role_allow`,
      roleDeny: Prisma.sql`o.role_deny`,
      userAllow: Prisma.sql`o.user_allow`,
      userDeny: Prisma.sql`o.user_deny`,
    });

    const advanced = await tx.$queryRaw<
      Array<{
        channel_id: string;
        last_read_message_id: string;
        prev_last_read_message_id: string | null;
        prev_last_read_message_created_at: Date | null;
      }>
    >(Prisma.sql`
      WITH me AS (
        SELECT role
          FROM "WorkspaceMember"
         WHERE "workspaceId" = ${workspaceId}::uuid
           AND "userId" = ${userId}::uuid
      ),
      -- summarize 와 동일한 ACL overrides 집계(단일 출처: readBitVisibleSql).
      overrides AS (
        SELECT
          cpo."channelId",
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_deny,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_deny
        FROM "ChannelPermissionOverride" cpo
        WHERE (
          (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
          OR (cpo."principalType" = 'ROLE' AND cpo."principalId" = (SELECT role::text FROM me))
        )
        GROUP BY cpo."channelId"
      ),
      visible_channels AS (
        SELECT c.id
          FROM "Channel" c
          LEFT JOIN overrides o ON o."channelId" = c.id
         WHERE c."workspaceId" = ${workspaceId}::uuid
           AND c."deletedAt" IS NULL
           AND ${visible}
      ),
      -- 각 가시 채널의 최신 (createdAt, id) 튜플 = 전진 목표.
      latest AS (
        SELECT DISTINCT ON (msg."channelId")
               msg."channelId" AS channel_id,
               msg.id          AS message_id,
               msg."createdAt" AS message_created_at
          FROM "Message" msg
          JOIN visible_channels vc ON vc.id = msg."channelId"
         WHERE msg."deletedAt" IS NULL
           -- S36 fix-forward (BLOCKER-1 · FR-TH-11): markAllRead 의 전진 목표(채널별
           -- 최신 튜플)도 roots-only 행에서 고른다 — 채널 unread 의 정본 술어와
           -- 정합. 답글만 더 최신이어도 채널 unread 는 그 답글을 세지 않으므로,
           -- 전진 커서도 마지막 root/broadcast 행을 가리켜야 unread 가 0 으로 수렴한다.
           AND (msg."parentMessageId" IS NULL OR msg."isBroadcast" = true)
         ORDER BY msg."channelId", msg."createdAt" DESC, msg.id DESC
      ),
      -- reviewer MAJOR: 덮어쓰기 직전 old 커서를 latest 와 미리 결합해 캡처한다.
      -- UPDATE 의 RETURNING 은 새 값만 주므로, prior 를 별도로 들고 와 전진한
      -- 채널과 join 한다. 신규 INSERT(기존 row 없음)는 prior 커서가 NULL.
      prior AS (
        SELECT l.channel_id,
               rs."lastReadMessageId"        AS prev_id,
               rs."lastReadMessageCreatedAt" AS prev_at
          FROM latest l
          LEFT JOIN "UserChannelReadState" rs
            ON rs."userId" = ${userId}::uuid AND rs."channelId" = l.channel_id
      ),
      upserted AS (
        INSERT INTO "UserChannelReadState"
          ("userId", "channelId", "lastReadEventId", "lastReadAt",
           "lastReadMessageId", "lastReadMessageCreatedAt", "updatedAt")
        SELECT
          ${userId}::uuid, l.channel_id, gen_random_uuid(), l.message_created_at,
          l.message_id, l.message_created_at, now()
        FROM latest l
        ON CONFLICT ("userId", "channelId") DO UPDATE
          SET "lastReadMessageId" = EXCLUDED."lastReadMessageId",
              "lastReadMessageCreatedAt" = EXCLUDED."lastReadMessageCreatedAt",
              "lastReadAt" = EXCLUDED."lastReadAt",
              "updatedAt" = now()
          -- monotonic guard(ackRead 와 동일): 저장 튜플보다 strictly 클 때만 전진.
          WHERE "UserChannelReadState"."lastReadMessageCreatedAt" IS NULL
             OR (
               "UserChannelReadState"."lastReadMessageCreatedAt",
               "UserChannelReadState"."lastReadMessageId"
             ) < (EXCLUDED."lastReadMessageCreatedAt", EXCLUDED."lastReadMessageId")
        RETURNING "channelId" AS channel_id, "lastReadMessageId" AS last_read_message_id
      )
      SELECT
        up.channel_id,
        up.last_read_message_id,
        p.prev_id AS prev_last_read_message_id,
        p.prev_at AS prev_last_read_message_created_at
      FROM upserted up
      JOIN prior p ON p.channel_id = up.channel_id
    `);

    // 전진한 채널은 최신까지 읽었으므로 unread/mention = 0. payload 를 만들어
    // 컨트롤러가 user 룸으로 fan-out 한다.
    return advanced.map((r) => ({
      channelId: r.channel_id,
      previousLastReadMessageId: r.prev_last_read_message_id,
      previousLastReadMessageCreatedAt: r.prev_last_read_message_created_at,
      payload: {
        channelId: r.channel_id,
        workspaceId,
        lastReadMessageId: r.last_read_message_id,
        unreadCount: 0,
        mentionCount: 0,
      },
    }));
  }

  // ───────────────────────────── S24 snapshot + Undo (FR-RS-18)

  /** read-all Redis 스냅샷 키. TTL 5분 윈도의 hot 경로. */
  private static readonly SNAPSHOT_TTL_MS = 5 * 60 * 1000;
  /** owner-mismatch claim 신호(소비하지 않음). */
  private static readonly SNAPSHOT_MISMATCH = '__mismatch__';
  /**
   * security HIGH #1: owner-gated 원자 스냅샷 claim Lua. 저장 JSON 의
   * userId/workspaceId 가 호출자와 일치할 때만 DEL 하고 값을 반환한다. 불일치면
   * 삭제하지 않고 '__mismatch__' 를 반환(타인 probe 가 정상 스냅샷을 소비 못 함).
   * 부재면 nil. KEYS[1]=key, ARGV[1]=userId, ARGV[2]=workspaceId.
   */
  private static readonly SNAPSHOT_CLAIM_LUA = `
    local raw = redis.call('get', KEYS[1])
    if not raw then return nil end
    local ok, parsed = pcall(cjson.decode, raw)
    if not ok then
      redis.call('del', KEYS[1])
      return raw
    end
    if parsed.userId == ARGV[1] and parsed.workspaceId == ARGV[2] then
      redis.call('del', KEYS[1])
      return raw
    end
    return '__mismatch__'
  `;
  private snapshotKey(snapshotId: string): string {
    return `read-all:snap:${snapshotId}`;
  }

  /**
   * S24 fix-forward: 스냅샷의 DB durable 저장(트랜잭션 내). advance 와 같은
   * 트랜잭션(tx)에서 실행돼, 실패 시 throw → 트랜잭션 롤백으로 ACK 까지 되돌린다
   * (스냅샷 없는 ACK 미잔류 = Undo 불가 상태 차단). markAllRead 가 호출.
   */
  private async persistSnapshotDb(
    tx: Prisma.TransactionClient,
    snapshotId: string,
    userId: string,
    workspaceId: string,
    snapshot: Record<string, SnapshotCursor>,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + UnreadService.SNAPSHOT_TTL_MS);
    await tx.markAllReadSnapshot.create({
      data: {
        id: snapshotId,
        userId,
        workspaceId,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        expiresAt,
      },
    });
  }

  /**
   * S24 fix-forward: Redis hot 저장(트랜잭션 밖 best-effort). DB durable 저장이
   * 이미 커밋된 뒤 호출되므로, Redis 실패가 Undo 가능성을 깨지 않는다(loadSnapshot
   * 이 DB 로 폴백). Redis 부재(단위 테스트)는 그대로 통과(DB-only durable).
   */
  private async cacheSnapshotRedis(
    snapshotId: string,
    userId: string,
    workspaceId: string,
    snapshot: Record<string, SnapshotCursor>,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const payload = JSON.stringify({ userId, workspaceId, snapshot });
      await this.redis.set(
        this.snapshotKey(snapshotId),
        payload,
        'PX',
        UnreadService.SNAPSHOT_TTL_MS,
      );
    } catch (err) {
      this.logger.warn(`[unread] snapshot redis cache failed: ${String(err).slice(0, 160)}`);
    }
  }

  /**
   * S24 (FR-RS-18) Undo: 스냅샷의 채널별 커서로 ChannelReadState 를 **되돌린다**
   * (後進 허용 — markUnread 와 동일한 비-monotonic 경로).
   *
   * ── S24 fix-forward (security HIGH #1 · reviewer MAJOR #2) ──
   *  - consume 원자화(double-Undo 차단): 복원 **전에** 스냅샷을 load-and-delete 로
   *    소비한다(DB deleteMany RETURNING + Redis GETDEL). 동시 두 번째 Undo 는
   *    이미 소비된 스냅샷을 찾지 못해 404 → 중복 복원 불가.
   *  - owner-mismatch / 만료 / parse 오류는 loadAndConsumeSnapshot 에서 404.
   *  - 복원은 채널별 직렬 setCursorBackward 가 아니라 **단일 set-based UPDATE FROM
   *    (VALUES …)** 으로 스냅샷 채널들을 일괄 후진시키고, 미읽/멘션 집계도 한 번의
   *    set-based 쿼리로 받는다(N×3 직렬 → 2 쿼리). 전체를 `$transaction` 으로 묶어
   *    부분 실패 시 복원이 일부만 적용되지 않게 한다.
   *
   * 복원된 채널마다 read_state:updated payload 를 반환해 컨트롤러가 user 룸으로
   * fan-out 한다(멀티세션 배지 복원).
   */
  async undoMarkAllRead(
    userId: string,
    workspaceId: string,
    snapshotId: string,
  ): Promise<ReadStateUpdatedPayload[]> {
    // security HIGH #1: load-and-delete(원자 소비) — double-Undo 차단. 소비 실패/
    // 부재/소유 불일치/만료는 404.
    const snapshot = await this.loadAndConsumeSnapshot(userId, workspaceId, snapshotId);

    const entries = Object.entries(snapshot);
    if (entries.length === 0) {
      // read-all 이 0 채널을 전진했던 경우 빈 스냅샷 → no-op(0 복원).
      return [];
    }

    // reviewer MAJOR #2: set-based 복원 + 집계를 단일 트랜잭션으로.
    const payloads = await this.prisma.$transaction(async (tx) => {
      await this.restoreCursorsSetBased(tx, userId, entries);
      return this.recountSetBased(tx, userId, workspaceId, entries);
    });

    await this.invalidateWorkspaceUserCache(workspaceId, userId);
    return payloads;
  }

  /**
   * S24 fix-forward (reviewer MAJOR #2): 스냅샷 채널들을 단일 set-based UPDATE FROM
   * (VALUES …) 으로 일괄 후진시킨다(채널별 직렬 setCursorBackward 대체). 스냅샷에
   * 들었으나 row 가 없던 채널은 INSERT, 있던 채널은 UPDATE 한다. 後進 허용(가드 없음
   * — markUnread 와 동일 비-monotonic 시맨틱). UUID/timestamptz 캐스팅으로 null
   * 커서(전체 미읽)도 정확히 복원한다.
   */
  private async restoreCursorsSetBased(
    tx: Prisma.TransactionClient,
    userId: string,
    entries: Array<[string, SnapshotCursor]>,
  ): Promise<void> {
    const now = new Date();
    const values = entries.map(([channelId, cursor]) => {
      const at = cursor.lastReadMessageCreatedAt ? new Date(cursor.lastReadMessageCreatedAt) : null;
      // lastReadAt 은 커서가 있으면 그 시각, 없으면 now() 로 둔다(row 존재 보장).
      return Prisma.sql`(
        ${channelId}::uuid,
        ${cursor.lastReadMessageId}::uuid,
        ${at}::timestamptz,
        ${at ?? now}::timestamptz
      )`;
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "UserChannelReadState"
        ("userId", "channelId", "lastReadEventId", "lastReadAt",
         "lastReadMessageId", "lastReadMessageCreatedAt", "updatedAt")
      SELECT
        ${userId}::uuid, v.channel_id, gen_random_uuid(), v.read_at,
        v.msg_id, v.msg_at, now()
      FROM (VALUES ${Prisma.join(values)})
        AS v(channel_id, msg_id, msg_at, read_at)
      ON CONFLICT ("userId", "channelId") DO UPDATE
        SET "lastReadMessageId" = EXCLUDED."lastReadMessageId",
            "lastReadMessageCreatedAt" = EXCLUDED."lastReadMessageCreatedAt",
            "lastReadAt" = EXCLUDED."lastReadAt",
            "updatedAt" = now()
    `);
  }

  /**
   * S24 fix-forward (reviewer MAJOR #2 · perf): 복원된 채널들의 미읽/멘션을 단일
   * set-based 쿼리로 재집계한다(채널별 unreadCountFor/mentionCountFor 2N 직렬
   * 대체). (createdAt, id) 튜플 커서 + mentionMatchSql 단일 출처를 재사용한다.
   */
  private async recountSetBased(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
    entries: Array<[string, SnapshotCursor]>,
  ): Promise<ReadStateUpdatedPayload[]> {
    const channelIds = entries.map(([channelId]) => Prisma.sql`${channelId}::uuid`);
    const mentionMatch = mentionMatchSql(Prisma.sql`msg`, Prisma.sql`${userId}::text`);
    const rows = await tx.$queryRaw<
      Array<{
        channel_id: string;
        last_read_message_id: string | null;
        unread_count: bigint | number;
        mention_count: bigint | number;
      }>
    >(Prisma.sql`
      WITH targets AS (
        SELECT unnest(ARRAY[${Prisma.join(channelIds)}]) AS channel_id
      )
      SELECT
        t.channel_id,
        rs."lastReadMessageId" AS last_read_message_id,
        COALESCE(m.unread_count, 0)  AS unread_count,
        COALESCE(m.mention_count, 0) AS mention_count
      FROM targets t
      LEFT JOIN "UserChannelReadState" rs
        ON rs."userId" = ${userId}::uuid AND rs."channelId" = t.channel_id
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS unread_count,
          count(*) FILTER (WHERE ${mentionMatch}) AS mention_count
        FROM "Message" msg
        WHERE msg."channelId" = t.channel_id
          AND msg."deletedAt" IS NULL
          AND (
            rs."lastReadMessageCreatedAt" IS NULL
            OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
          )
      ) m ON true
    `);
    return rows.map((r) => ({
      channelId: r.channel_id,
      workspaceId,
      lastReadMessageId: r.last_read_message_id,
      unreadCount: Number(r.unread_count ?? 0),
      mentionCount: Number(r.mention_count ?? 0),
    }));
  }

  /**
   * S24 fix-forward (security HIGH #1): Undo 스냅샷을 **원자적으로 load-and-delete**
   * 한다(double-Undo 차단 + IDOR 방어 + 만료 차단).
   *
   *  - Redis: **owner-gated 원자 claim Lua**(CLAIM_LUA). 저장된 JSON 의 owner 가
   *    호출자(userId/workspaceId)와 일치할 때만 DEL 하고 값을 반환한다 — 불일치면
   *    삭제하지 않고 mismatch 신호만 준다(타인 probe 가 정상 스냅샷을 소비하지
   *    못하게; 단순 GETDEL 이면 owner 검사 전에 삭제돼 DoS/소비 취약). 동시 두 번째
   *    Undo 는 이미 DEL 돼 nil → DB 폴백 → DB 도 소비/만료 → 404. mismatch/parse
   *    오류는 **즉시 404**(조용한 DB fallthrough 금지). Redis 권위 경로에서도 DB
   *    durable row 를 함께 소비해 폴백 부활을 막는다.
   *  - DB: `DELETE … WHERE id+소유+(expiresAt > now()) RETURNING snapshot` 단일
   *    원자 statement 로 load-and-delete(만료 차단 + double-Undo 차단 + IDOR 방어).
   *    0 row → 이미 소비/부재/만료/소유 불일치 → 404.
   */
  private async loadAndConsumeSnapshot(
    userId: string,
    workspaceId: string,
    snapshotId: string,
  ): Promise<Record<string, SnapshotCursor>> {
    if (this.redis) {
      // owner-gated 원자 claim: owner 일치 시에만 DEL+반환, 불일치면 '__mismatch__',
      // 부재면 nil. KEYS[1]=snapshotKey, ARGV[1]=userId, ARGV[2]=workspaceId.
      let result: string | null = null;
      try {
        result = (await this.redis.eval(
          UnreadService.SNAPSHOT_CLAIM_LUA,
          1,
          this.snapshotKey(snapshotId),
          userId,
          workspaceId,
        )) as string | null;
      } catch (err) {
        this.logger.warn(`[unread] snapshot claim failed: ${String(err).slice(0, 160)}`);
      }
      if (result === UnreadService.SNAPSHOT_MISMATCH) {
        // owner-mismatch → 즉시 404(DB fallthrough 금지). 스냅샷은 소비되지 않았다.
        throw new DomainError(ErrorCode.NOT_FOUND, 'mark-all-read snapshot not found or expired');
      }
      if (result) {
        // DB durable row 도 함께 소비(Redis 권위 경로에서도 double-Undo 가 DB 폴백
        // 으로 부활하지 못하게). 소유 조건을 걸어 타인 row 는 건드리지 않는다.
        await this.prisma.markAllReadSnapshot
          .deleteMany({ where: { id: snapshotId, userId, workspaceId } })
          .catch(() => undefined);
        let parsed: {
          userId: string;
          workspaceId: string;
          snapshot: Record<string, SnapshotCursor>;
        };
        try {
          parsed = JSON.parse(result);
        } catch {
          // parse 오류 → 조용한 DB 우회 금지, 즉시 404.
          throw new DomainError(ErrorCode.NOT_FOUND, 'mark-all-read snapshot not found or expired');
        }
        return parsed.snapshot;
      }
    }

    // Redis miss(또는 Redis 부재) → DB durable 폴백. `DELETE … WHERE id+소유+
    // (expiresAt > now()) RETURNING snapshot` 으로 load-and-delete 를 단일 원자
    // statement 화한다(security HIGH #1: 만료 차단 + double-Undo 차단 + IDOR 방어).
    // 0 row 반환 → 이미 소비/부재/만료/소유 불일치 → 404.
    const rows = await this.prisma.$queryRaw<Array<{ snapshot: unknown }>>(Prisma.sql`
      DELETE FROM "MarkAllReadSnapshot"
       WHERE "id" = ${snapshotId}::uuid
         AND "userId" = ${userId}::uuid
         AND "workspaceId" = ${workspaceId}::uuid
         AND "expiresAt" > now()
      RETURNING "snapshot"
    `);
    if (rows.length === 0) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'mark-all-read snapshot not found or expired');
    }
    return rows[0].snapshot as Record<string, SnapshotCursor>;
  }

  // ───────────────────────────── Redis cache (FR-RS-14)

  /**
   * FR-RS-14 + fix-forward (MAJOR-A/CRITICAL-B): 워크스페이스 단일 사용자 unread
   * 캐시 read-through. me-unread-totals 컨트롤러가 워크스페이스별로 이 경로를
   * 타 실제 캐시가 동작한다(종전엔 summarizeWorkspaceTotals 직접 호출 → 캐시
   * 우회였다 — MAJOR-A).
   *
   * stampede 방어(CRITICAL-B):
   *  1. 캐시 히트면 즉시 반환.
   *  2. 미스면 `unread:lock` 을 per-call 랜덤 토큰으로 SET NX PX 시도.
   *  3. 선점하면 무거운 summarize 를 실행 → writeCache → fenced unlock.
   *  4. 선점 못 하면 무거운 SQL 을 바로 치지 않고 짧게(50ms×3) 대기하며 캐시
   *     재조회 — 선점자가 채운 결과를 공유한다.
   *  5. 그래도 미스면(선점자 실패/지연) 그때만 DB 폴백(writeCache 없이).
   */
  async cachedWorkspaceTotal(workspaceId: string, userId: string): Promise<UnreadWorkspaceTotal> {
    if (!this.redis) {
      return this.aggregateSingleWorkspace(workspaceId, userId);
    }
    const key = this.cacheKey(workspaceId, userId);
    const hit = await this.readCache(key);
    if (hit) {
      return this.foldCache(workspaceId, hit);
    }

    // CRITICAL-B: stampede 락. per-call 랜덤 토큰 — fenced unlock 으로만 해제.
    const lockKey = this.lockKey(workspaceId, userId);
    const token = randomUUID();
    const got = await this.redis.set(lockKey, token, 'PX', this.lockTtlMs(), 'NX');

    if (got !== 'OK') {
      // 락 미선점: 무거운 집계를 바로 치지 않고 선점자의 캐시 쓰기를 짧게 대기.
      for (let i = 0; i < UnreadService.LOCK_WAIT_ATTEMPTS; i += 1) {
        await this.sleep(UnreadService.LOCK_WAIT_MS);
        const retried = await this.readCache(key);
        if (retried) {
          return this.foldCache(workspaceId, retried);
        }
      }
      // 여전히 미스(선점자 실패/지연) → DB 폴백(캐시 쓰기 없음, 락 미보유).
      return this.aggregateSingleWorkspace(workspaceId, userId);
    }

    // 락 선점자: 집계 + writeCache. fenced unlock 으로 내 토큰일 때만 DEL.
    try {
      const channels = await this.summarize(workspaceId, userId);
      const total = this.foldChannels(workspaceId, channels);
      await this.writeCache(key, channels);
      return total;
    } finally {
      await this.unlock(lockKey, token);
    }
  }

  /**
   * FR-RS-14: 채널이 속한 워크스페이스의 unread 캐시 Hash 를 통째로 무효화한다.
   * ACK / markRead 가 호출. 조회한 workspaceId 를 반환해 ACK 페이로드가 재사용할
   * 수 있게 한다(NIT-G). Redis 부재(단위테스트) 또는 실패 시 조용히 통과.
   */
  async invalidateUserCacheForChannel(userId: string, channelId: string): Promise<string | null> {
    let workspaceId: string | null = null;
    try {
      const ch = await this.prisma.channel.findUnique({
        where: { id: channelId },
        select: { workspaceId: true },
      });
      workspaceId = ch?.workspaceId ?? null;
      if (!this.redis || !workspaceId) return workspaceId;
      await this.redis.del(this.cacheKey(workspaceId, userId));
    } catch (err) {
      this.logger.warn(`[unread] cache invalidate failed: ${String(err).slice(0, 160)}`);
    }
    return workspaceId;
  }

  /**
   * FR-RS-14: 새 메시지 / 멤버 변경 등 외부 이벤트가 워크스페이스의 한 사용자
   * unread 캐시를 무효화할 때 쓰는 직접 키 버전.
   */
  async invalidateWorkspaceUserCache(workspaceId: string, userId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.cacheKey(workspaceId, userId));
    } catch (err) {
      this.logger.warn(`[unread] cache invalidate failed: ${String(err).slice(0, 160)}`);
    }
  }

  /**
   * S36 (FR-TH-14, 옵션 A): broadcast 행 soft-delete 시 채널 unread 캐시를 즉시
   * 무효화한다. 채널 unread 캐시 키(`unread:{ws}:{user}`)는 per-user 라, broadcast
   * 가 모든 워크스페이스 멤버의 채널 미읽에 영향을 주므로 해당 워크스페이스 멤버
   * 전원의 캐시를 한 번에 지운다(멤버십이 정본 — 채널별 SCAN 회피). 멤버 수는
   * Discord-parity 로 bounded 이고 단일 pipeline 1 round-trip 으로 처리한다.
   *
   * channelId 를 받아 내부에서 workspaceId 를 1회 SELECT 한다(호출측이 broadcast
   * 행 삭제 후 채널 컨텍스트만 알면 되도록). 무효화 실패는 캐시 TTL(2h) 자연
   * 만료에 맡긴다(FR-TH-14 "재갱신 보장" — 다음 read-through 가 DB 재집계로 정정).
   */
  async invalidateChannelWorkspaceAllMembers(channelId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const ch = await this.prisma.channel.findUnique({
        where: { id: channelId },
        select: { workspaceId: true },
      });
      const workspaceId = ch?.workspaceId;
      if (!workspaceId) return;
      const members = await this.prisma.workspaceMember.findMany({
        where: { workspaceId },
        select: { userId: true },
      });
      if (members.length === 0) return;
      const pipe = this.redis.pipeline();
      for (const m of members) pipe.del(this.cacheKey(workspaceId, m.userId));
      await pipe.exec();
    } catch (err) {
      this.logger.warn(`[unread] broadcast cache invalidate failed: ${String(err).slice(0, 160)}`);
    }
  }

  // ───────────────────────────── private helpers

  private aggregateSingleWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<UnreadWorkspaceTotal> {
    return this.summarize(workspaceId, userId).then((channels) =>
      this.foldChannels(workspaceId, channels),
    );
  }

  private foldChannels(
    workspaceId: string,
    channels: UnreadChannelSummary[],
  ): UnreadWorkspaceTotal {
    let unreadCount = 0;
    let mentionCount = 0;
    let hasMention = false;
    for (const c of channels) {
      unreadCount += c.unreadCount;
      mentionCount += c.mentionCount;
      hasMention = hasMention || c.hasMention;
    }
    return { workspaceId, unreadCount, hasMention, mentionCount };
  }

  private cacheKey(workspaceId: string, userId: string): string {
    return `unread:${workspaceId}:${userId}`;
  }

  private lockKey(workspaceId: string, userId: string): string {
    return `unread:lock:${workspaceId}:${userId}`;
  }

  /**
   * CRITICAL-B: 락 TTL(ms). 집계 P99 를 고려해 기본 2000ms 로 상향. 환경변수
   * 오버라이드는 (0, 5000] 범위로 클램프한다 — 0/음수/과대값은 락이 영구
   * 잔류하거나 즉시 만료돼 stampede 방어가 무의미해지므로 기본값으로 폴백.
   */
  private lockTtlMs(): number {
    const raw = Number(process.env.UNREAD_LOCK_TTL);
    return Number.isFinite(raw) && raw > 0 && raw <= 5000 ? raw : 2000;
  }

  /** fenced unlock: 저장된 토큰이 내 것일 때만 DEL(타 홀더 락 보호). */
  private async unlock(lockKey: string, token: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(UnreadService.UNLOCK_LUA, 1, lockKey, token);
    } catch (err) {
      // DEL 실패는 TTL 만료에 맡긴다(타 홀더 락은 절대 삭제하지 않음).
      this.logger.warn(`[unread] lock release failed: ${String(err).slice(0, 160)}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async readCache(key: string): Promise<Record<string, CachedChannelEntry> | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.hgetall(key);
      if (!raw || Object.keys(raw).length === 0) return null;
      const out: Record<string, CachedChannelEntry> = {};
      for (const [channelId, json] of Object.entries(raw)) {
        const parsed = JSON.parse(json) as CachedChannelEntry;
        out[channelId] = {
          unreadCount: Number(parsed.unreadCount ?? 0),
          mentionCount: Number(parsed.mentionCount ?? 0),
        };
      }
      return out;
    } catch (err) {
      this.logger.warn(`[unread] cache read failed: ${String(err).slice(0, 160)}`);
      return null;
    }
  }

  private async writeCache(key: string, channels: UnreadChannelSummary[]): Promise<void> {
    if (!this.redis) return;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.del(key);
      // 빈 워크스페이스(채널 0 또는 unread 없음)도 키를 남겨야 다음 조회가
      // 히트하므로 sentinel 엔트리를 둔다(빈 Hash 는 Redis 에 존재하지 못함).
      pipeline.hset(key, '__ws__', JSON.stringify({ unreadCount: 0, mentionCount: 0 }));
      for (const c of channels) {
        pipeline.hset(
          key,
          c.channelId,
          JSON.stringify({ unreadCount: c.unreadCount, mentionCount: c.mentionCount }),
        );
      }
      pipeline.pexpire(key, UnreadService.CACHE_TTL_MS);
      await pipeline.exec();
    } catch (err) {
      this.logger.warn(`[unread] cache write failed: ${String(err).slice(0, 160)}`);
    }
  }

  private foldCache(
    workspaceId: string,
    entries: Record<string, CachedChannelEntry>,
  ): UnreadWorkspaceTotal {
    let unreadCount = 0;
    let mentionCount = 0;
    for (const [channelId, e] of Object.entries(entries)) {
      if (channelId === '__ws__') continue; // sentinel
      unreadCount += e.unreadCount;
      mentionCount += e.mentionCount;
    }
    return {
      workspaceId,
      unreadCount,
      mentionCount,
      hasMention: mentionCount > 0,
    };
  }
}
