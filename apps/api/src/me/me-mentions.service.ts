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
  // S44 contract fix-forward: @here 멘션 표식. 웹 dispatcher 가 mention:new wire
  // 페이로드(서버 MentionReceivedPayload)로 캐시에 here 를 채우므로, REST 인박스
  // 응답도 동일 필드를 실어야 라이브 병합과 형태가 어긋나지 않는다(레거시 row 는
  // mentions JSONB 에 here 키가 없어 null→false 폴백).
  here: boolean;
  // FR-MN-10 (066 / S93): 키워드 알림 유래 표식. 이 메시지에 호출자의 KEYWORD MentionRecord
  // 가 있으면 true(본문에 등록 키워드가 어절 정확 일치해 알림된 것). @user/@everyone 유래
  // 멘션은 false. UI 가 Inbox 에서 "키워드 알림" 레이블을 분기하는 데 쓴다.
  keyword: boolean;
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
 *
 * Task-019-A (reviewer BLOCKER-2 fix): private-channel ACL filter is
 * applied SQL-side — a mention record whose channel is private and
 * the caller isn't whitelisted for MUST NOT leak its contentPlain
 * snippet back. Public channels pass through unchanged; OWNER sees
 * everything; otherwise `(allow & ~deny) & READ_BIT > 0` must hold
 * against the workspace member's role and userId.
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
        here: boolean;
        keyword: boolean;
      }>
    >`
      SELECT
        m.id          AS "id",
        m."channelId" AS "channelId",
        c."workspaceId" AS "workspaceId",
        m."authorId"  AS "authorId",
        LEFT(m."contentPlain", 140) AS snippet,
        m."createdAt" AS "createdAt",
        (m.mentions->>'everyone')::boolean AS "everyone",
        -- S44 contract: @here 표식. 레거시 row(here 키 없음)는 NULL → false 폴백.
        COALESCE((m.mentions->>'here')::boolean, false) AS "here",
        -- FR-MN-10: 이 메시지에 호출자의 KEYWORD MentionRecord 가 있으면 키워드 유래.
        EXISTS (
          SELECT 1 FROM "MentionRecord" mr
           WHERE mr."messageId" = m.id
             AND mr."targetId" = ${userId}::uuid
             AND mr."targetType" = 'KEYWORD'
        ) AS "keyword"
      FROM "Message" m
      JOIN "Channel" c ON c.id = m."channelId" AND c."deletedAt" IS NULL
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
          -- FR-MN-10 (066): 호출자에 대한 MentionRecord(키워드/@role expand)가 있으면
          -- 멘션으로 노출한다(추가형 OR · ACL 절은 그대로 AND 로 적용돼 비가시 private
          -- 매치는 여전히 필터됨). @role(USER record 기록) historical Inbox 미노출 latent
          -- 갭도 함께 해소된다(@here/@everyone 은 MentionRecord 미기록이라 무관 — 종전대로
          -- everyone JSON 플래그로만 노출).
          OR EXISTS (
            SELECT 1 FROM "MentionRecord" mr
             WHERE mr."messageId" = m.id AND mr."targetId" = ${userId}::uuid
          )
        )
        -- task-019-A: private-channel ACL filter. Public channels pass;
        -- OWNER sees all; else (allow & ~deny) & READ_BIT > 0 required.
        AND (
          c."isPrivate" = false
          OR wm.role = 'OWNER'
          OR COALESCE(
               (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                  FROM "ChannelPermissionOverride" cpo
                 WHERE cpo."channelId" = c.id
                   AND (
                     (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                     -- S62 (FR-RM03): 시스템 역할 리터럴 + 커스텀 Role UUID override.
                     OR (cpo."principalType" = 'ROLE' AND (
                           cpo."principalId" = wm.role::text
                           OR cpo."principalId" IN (
                                SELECT mr."roleId"::text FROM "MemberRole" mr
                                 WHERE mr."userId" = ${userId}::uuid
                                   AND mr."workspaceId" = c."workspaceId"
                              )
                        ))
                   )),
               0
             ) > 0
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
      here: r.here === true,
      keyword: r.keyword === true,
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
      JOIN "Channel" c ON c.id = m."channelId" AND c."deletedAt" IS NULL
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
          -- FR-MN-10 (066): MentionRecord(키워드/@role expand) 도 읽지 않음 멘션으로 집계
          -- (recent() 와 동일 OR · ACL 절 AND 보존).
          OR EXISTS (
            SELECT 1 FROM "MentionRecord" mr
             WHERE mr."messageId" = m.id AND mr."targetId" = ${userId}::uuid
          )
        )
        -- task-019-A: private-channel ACL filter (mirrors recent()).
        AND (
          c."isPrivate" = false
          OR wm.role = 'OWNER'
          OR COALESCE(
               (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                  FROM "ChannelPermissionOverride" cpo
                 WHERE cpo."channelId" = c.id
                   AND (
                     (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                     -- S62 (FR-RM03): 시스템 역할 리터럴 + 커스텀 Role UUID override.
                     OR (cpo."principalType" = 'ROLE' AND (
                           cpo."principalId" = wm.role::text
                           OR cpo."principalId" IN (
                                SELECT mr."roleId"::text FROM "MemberRole" mr
                                 WHERE mr."userId" = ${userId}::uuid
                                   AND mr."workspaceId" = c."workspaceId"
                              )
                        ))
                   )),
               0
             ) > 0
        )
    `;
    const row = result[0];
    return Number(row?.count ?? 0);
  }
}
