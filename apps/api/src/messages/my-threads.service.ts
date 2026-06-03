import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import type { ThreadListItem, ThreadNotificationLevel } from '@qufox/shared-types';

/**
 * S38 (D04 / FR-TH-09 / FR-TH-10) — Threads 탭 백엔드.
 *
 * 내 구독 스레드(ThreadSubscription) 목록을 채널 멤버십/가시성 ACL 로 필터해
 * 반환하고(FR-TH-09), 전체를 각 스레드 최신 답글까지 한 번에 읽음 처리한다
 * (FR-TH-10). 둘 다 **단일 쿼리**로 N+1 을 회피한다.
 *
 * unread = 옵션 B 계산(S36 결정 계속). ThreadReadState 에 denormalized
 * unreadCount 컬럼을 두지 않고, GET 응답서 (createdAt, id) 튜플 커서 기준
 * COUNT 로 산정한다 — 채널 미읽 철학(drift 원천 차단)과 정합. 미읽 공식은
 * ThreadReadStateService.unreadCountFor 와 동일하다(isBroadcast=false ·
 * deletedAt 제외 · 튜플 비교).
 *
 * ── 채널 ACL 필터(FR-TH-09) ──
 * 구독은 채널 권한과 독립적으로 남아있을 수 있으므로(채널 탈퇴/비공개화 후에도
 * 구독 행은 잔존), 목록은 요청자가 지금도 루트 채널을 READ 할 수 있는 스레드만
 * 반환한다. ACL 은 UnreadService.readBitVisibleSql 와 동일한 5단계 fold 를
 * **cross-workspace** 로 적용한다(스레드는 여러 워크스페이스에 걸쳐 있으므로
 * 채널의 workspaceId 별 요청자 role 을 join 한다). DM(DIRECT) 채널은 USER
 * 멤버십 override(allowMask & READ)로 가시성이 결정된다(비-DIRECT 채널의
 * isPrivate=false 와 동일 fold 경로 — 별도 분기 불필요).
 */
@Injectable()
export class MyThreadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-TH-09: 내 구독 스레드 목록. 미읽(unread>0) 우선, 그 안에서 latestReplyAt
   * DESC. 단일 쿼리(ThreadSubscription JOIN Message JOIN Channel + ThreadReadState
   * LEFT JOIN + unread COUNT 서브쿼리 + 마지막 답글자 LATERAL). 채널 멤버십/가시성
   * ACL 필터로 탈퇴/비공개 비멤버 스레드를 제외한다.
   */
  async listMine(userId: string): Promise<ThreadListItem[]> {
    // cross-workspace READ 가시성 fold. UnreadService.readBitVisibleSql 와 동일한
    // 5단계 비트 fold 지만, 채널마다 workspaceId 가 다르므로 요청자 role 을 채널의
    // 워크스페이스로 join 해 ROLE override 를 해석한다. 비-private 채널은 무조건
    // 통과(fold 첫 항). DM(DIRECT)·private 채널은 USER/ROLE override 로 결정.
    const rows = await this.prisma.$queryRaw<
      Array<{
        parent_message_id: string;
        channel_id: string;
        channel_name: string;
        excerpt: string;
        latest_reply_at: Date | null;
        last_replier_id: string | null;
        unread_count: bigint | number;
        notification_level: ThreadNotificationLevel;
      }>
    >(Prisma.sql`
      WITH subs AS (
        SELECT ts."threadParentId" AS parent_id, ts."notificationLevel" AS level
          FROM "ThreadSubscription" ts
         WHERE ts."userId" = ${userId}::uuid
      ),
      roots AS (
        SELECT
          m.id              AS parent_id,
          m."channelId"     AS channel_id,
          m."contentPlain"  AS content_plain,
          m."latestReplyAt" AS latest_reply_at,
          s.level           AS level,
          c."name"          AS channel_name,
          c."isPrivate"     AS is_private,
          c."workspaceId"   AS workspace_id
        FROM subs s
        JOIN "Message" m ON m.id = s.parent_id AND m."deletedAt" IS NULL
        -- S38 fix-forward (보안 LOW): archived 채널 스레드는 목록에서 제외한다
        -- (resolveThreadRootForAcl 의 CHANNEL_ARCHIVED 패턴과 일관 — 보관 채널의
        -- 스레드는 GET/ack 가 막히므로 Threads 탭에도 노출하지 않는다).
        JOIN "Channel" c ON c.id = m."channelId" AND c."deletedAt" IS NULL AND c."archivedAt" IS NULL
      ),
      -- 채널 워크스페이스별 요청자 role(없으면 비멤버 → NULL).
      with_role AS (
        SELECT r.*, wm.role AS my_role
          FROM roots r
          LEFT JOIN "WorkspaceMember" wm
            ON wm."workspaceId" = r.workspace_id
           AND wm."userId" = ${userId}::uuid
      ),
      -- 채널별 USER/ROLE override bit_or(요청자 본인 + 요청자 role 만).
      with_ovr AS (
        SELECT
          wr.*,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_deny,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_deny
        FROM with_role wr
        LEFT JOIN "ChannelPermissionOverride" cpo
          ON cpo."channelId" = wr.channel_id
         AND (
           (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
           -- S62 (FR-RM03): 시스템 역할 리터럴 + 커스텀 Role UUID override.
           OR (cpo."principalType" = 'ROLE' AND (
                 cpo."principalId" = wr.my_role::text
                 OR cpo."principalId" IN (
                      SELECT mr."roleId"::text FROM "MemberRole" mr
                       WHERE mr."userId" = ${userId}::uuid
                         AND mr."workspaceId" = wr.workspace_id
                    )
              ))
         )
        GROUP BY
          wr.parent_id, wr.channel_id, wr.content_plain, wr.latest_reply_at,
          wr.level, wr.channel_name, wr.is_private, wr.workspace_id, wr.my_role
      ),
      visible AS (
        SELECT *
          FROM with_ovr
         WHERE
           -- 워크스페이스 채널은 멤버여야 하고(my_role NOT NULL), DM(workspace_id
           -- NULL)은 멤버십 override 로 판정(아래 fold 의 user_allow & READ).
           (workspace_id IS NULL OR my_role IS NOT NULL)
           AND (
             is_private = false
             OR (
               (
                 (
                   (
                     (CASE
                        WHEN ((COALESCE(user_allow, 0) | COALESCE(role_allow, 0)) & 1) > 0 THEN 1
                        ELSE 0
                      END)
                     | (COALESCE(role_allow, 0) & 1)
                   )
                   & ~(COALESCE(role_deny, 0) & 1)
                 )
                 | (COALESCE(user_allow, 0) & 1)
               )
               & ~(COALESCE(user_deny, 0) & 1)
             ) > 0
           )
      )
      SELECT
        v.parent_id      AS parent_message_id,
        v.channel_id     AS channel_id,
        v.channel_name   AS channel_name,
        v.content_plain  AS excerpt,
        v.latest_reply_at AS latest_reply_at,
        lr.author_id     AS last_replier_id,
        COALESCE(uc.unread_count, 0) AS unread_count,
        v.level          AS notification_level
      FROM visible v
      LEFT JOIN "ThreadReadState" rs
        ON rs."userId" = ${userId}::uuid
       AND rs."parentMessageId" = v.parent_id
      -- 미읽 답글 수(옵션 B 계산 — unreadCountFor 와 동일 술어).
      LEFT JOIN LATERAL (
        SELECT count(*) AS unread_count
          FROM "Message" msg
         WHERE msg."parentMessageId" = v.parent_id
           AND msg."isBroadcast" = false
           AND msg."deletedAt" IS NULL
           AND (
             rs."lastReadMessageCreatedAt" IS NULL
             OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
           )
      ) uc ON true
      -- 마지막(최신) 비삭제·비broadcast 답글 작성자.
      LEFT JOIN LATERAL (
        SELECT msg."authorId" AS author_id
          FROM "Message" msg
         WHERE msg."parentMessageId" = v.parent_id
           AND msg."isBroadcast" = false
           AND msg."deletedAt" IS NULL
         ORDER BY msg."createdAt" DESC, msg.id DESC
         LIMIT 1
      ) lr ON true
      -- 미읽 우선(unread>0) DESC → 그 안 latestReplyAt DESC(답글 없으면 후순위).
      ORDER BY
        (COALESCE(uc.unread_count, 0) > 0) DESC,
        v.latest_reply_at DESC NULLS LAST,
        v.parent_id DESC
    `);

    return rows.map((r) => ({
      parentMessageId: r.parent_message_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      excerpt: buildThreadExcerpt(r.excerpt),
      latestReplyAt: r.latest_reply_at ? r.latest_reply_at.toISOString() : null,
      lastReplierId: r.last_replier_id,
      unreadCount: Number(r.unread_count ?? 0),
      notificationLevel: r.notification_level,
    }));
  }

  /**
   * FR-TH-10: 내 구독 스레드 전체를 각 스레드 최신 답글까지 읽음 처리. 단일 쿼리로
   * 각 스레드의 최신(createdAt, id) 답글을 구해 ThreadReadState 를 monotonic
   * bulk upsert 한다(N+1 없음 · 퇴행 ack no-op). ackThread 와 동일 monotonic guard.
   *
   * S38 fix-forward (security MEDIUM): listMine 과 동일한 채널 ACL `visible` CTE 를
   * INSERT…SELECT 에 적용해, 요청자가 지금도 루트 채널을 READ 할 수 있는 구독
   * 스레드만 ack 한다. 종전엔 채널 ACL 없이 ts."userId" = me 인 구독 전체를
   * ack 해, 강퇴/비공개화 후 잔존한 구독 행(비멤버 스레드)의 ThreadReadState 까지
   * 갱신했다 — 비록 read-state 자체엔 본문 누출이 없으나, 권한 없는 스레드의
   * 메시지 id/시각(lastReadMessageId·CreatedAt)을 자기 행에 기록하므로 listMine 의
   * 가시성 정책과 어긋났다(필터 일관성 위반). 이제 두 경로가 같은 fold 를 쓴다.
   *
   * 반환: 전진(또는 신규 INSERT)한 스레드 수.
   */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ parent_message_id: string }>>(Prisma.sql`
      WITH subs AS (
        SELECT ts."threadParentId" AS parent_id
          FROM "ThreadSubscription" ts
         WHERE ts."userId" = ${userId}::uuid
      ),
      roots AS (
        SELECT
          m.id            AS parent_id,
          m."channelId"   AS channel_id,
          c."isPrivate"   AS is_private,
          c."workspaceId" AS workspace_id
        FROM subs s
        JOIN "Message" m ON m.id = s.parent_id AND m."deletedAt" IS NULL
        -- listMine 정합(보안 LOW): archived 채널 스레드도 read-all 대상에서 제외한다.
        JOIN "Channel" c ON c.id = m."channelId" AND c."deletedAt" IS NULL AND c."archivedAt" IS NULL
      ),
      with_role AS (
        SELECT r.*, wm.role AS my_role
          FROM roots r
          LEFT JOIN "WorkspaceMember" wm
            ON wm."workspaceId" = r.workspace_id
           AND wm."userId" = ${userId}::uuid
      ),
      with_ovr AS (
        SELECT
          wr.*,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'ROLE'), 0) AS role_deny,
          COALESCE(bit_or(cpo."allowMask") FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_allow,
          COALESCE(bit_or(cpo."denyMask")  FILTER (WHERE cpo."principalType" = 'USER'), 0) AS user_deny
        FROM with_role wr
        LEFT JOIN "ChannelPermissionOverride" cpo
          ON cpo."channelId" = wr.channel_id
         AND (
           (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
           -- S62 (FR-RM03): 시스템 역할 리터럴 + 커스텀 Role UUID override.
           OR (cpo."principalType" = 'ROLE' AND (
                 cpo."principalId" = wr.my_role::text
                 OR cpo."principalId" IN (
                      SELECT mr."roleId"::text FROM "MemberRole" mr
                       WHERE mr."userId" = ${userId}::uuid
                         AND mr."workspaceId" = wr.workspace_id
                    )
              ))
         )
        GROUP BY
          wr.parent_id, wr.channel_id, wr.is_private, wr.workspace_id, wr.my_role
      ),
      visible AS (
        SELECT parent_id
          FROM with_ovr
         WHERE
           (workspace_id IS NULL OR my_role IS NOT NULL)
           AND (
             is_private = false
             OR (
               (
                 (
                   (
                     (CASE
                        WHEN ((COALESCE(user_allow, 0) | COALESCE(role_allow, 0)) & 1) > 0 THEN 1
                        ELSE 0
                      END)
                     | (COALESCE(role_allow, 0) & 1)
                   )
                   & ~(COALESCE(role_deny, 0) & 1)
                 )
                 | (COALESCE(user_allow, 0) & 1)
               )
               & ~(COALESCE(user_deny, 0) & 1)
             ) > 0
           )
      )
      INSERT INTO "ThreadReadState"
        ("id", "userId", "parentMessageId",
         "lastReadMessageId", "lastReadMessageCreatedAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        ${userId}::uuid,
        latest.parent_id,
        latest.last_id,
        latest.last_at,
        now()
      FROM (
        -- READ 권한이 있는(visible) 구독 스레드별 최신 비삭제·비broadcast 답글의
        -- (createdAt, id). 답글이 하나도 없는 스레드(last_id NULL)는 ACK 대상에서
        -- 제외한다. visible CTE 로 조인해 권한 없는 스레드를 처음부터 배제한다.
        SELECT DISTINCT ON (m."parentMessageId")
          m."parentMessageId" AS parent_id,
          m.id                AS last_id,
          m."createdAt"       AS last_at
        FROM visible v
        JOIN "Message" m
          ON m."parentMessageId" = v.parent_id
         AND m."isBroadcast" = false
         AND m."deletedAt" IS NULL
        ORDER BY m."parentMessageId", m."createdAt" DESC, m.id DESC
      ) latest
      ON CONFLICT ("userId", "parentMessageId") DO UPDATE
        SET "lastReadMessageId" = EXCLUDED."lastReadMessageId",
            "lastReadMessageCreatedAt" = EXCLUDED."lastReadMessageCreatedAt",
            "updatedAt" = now()
        WHERE "ThreadReadState"."lastReadMessageCreatedAt" IS NULL
           OR (
             "ThreadReadState"."lastReadMessageCreatedAt",
             "ThreadReadState"."lastReadMessageId"
           ) < (EXCLUDED."lastReadMessageCreatedAt", EXCLUDED."lastReadMessageId")
      RETURNING "parentMessageId" AS parent_message_id
    `);
    return { updated: rows.length };
  }
}

/**
 * FR-TH-09: 루트 평문 excerpt 80자 cap. 공백 정규화 후 80자 초과 시 79자 + "…".
 * 별도 상수로 PRD 의 "excerpt(80자)" 를 명시한다.
 */
export const THREAD_LIST_EXCERPT_CAP = 80;

export function buildThreadExcerpt(content: string | null | undefined): string {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= THREAD_LIST_EXCERPT_CAP) return collapsed;
  return collapsed.slice(0, THREAD_LIST_EXCERPT_CAP - 1) + '…';
}
