import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SAVED_LIMIT,
  type SaveStatus,
  type SavedMessageDto,
  type SavedMessageListResponse,
  type SaveToggleResponse,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

// 목록 요약 excerpt 길이 상한(≤150자). 전체 MessageDto 대신 평문 요약만 노출한다.
const EXCERPT_LEN = 150;
// 삭제된 원본의 placeholder. messageDeletedAt 이 채워진 행은 excerpt 를 이 값으로 마스킹.
const DELETED_PLACEHOLDER = '[삭제된 메시지]';

// GET /me/saved 의 raw 조인 결과 한 행.
interface SavedRow {
  id: string;
  messageId: string;
  status: SaveStatus;
  savedAt: Date;
  messageDeletedAt: Date | null;
  excerpt: string | null;
  authorId: string;
  channelId: string;
  channelName: string | null;
}

/**
 * S51 (D10 / FR-PS-07): 개인 저장함(Saved Messages) 서비스. 철저히 개인 전용 —
 * Socket.IO 이벤트 불필요. 저장은 (userId, messageId) @@unique 로 idempotent 하며,
 * 저장 전 카운트가 SAVED_LIMIT(500) 이상이면 422 로 거부한다(soft·advisory lock
 * 불요·±1 drift 허용). 메시지 가시성(채널 READ ACL)을 확인해 접근 불가 채널 메시지의
 * 저장을 차단한다(me-mentions.service 의 ACL SQL 패턴 재사용).
 *
 * 목록 조회는 원본 message 요약(excerpt ≤150자 + author + channel)만 조인한다 —
 * 전체 MessageDto reaction/attachment 배치조인은 하지 않는다(복잡도 회피). 원본이
 * soft-delete/삭제됐으면 messageDeletedAt 을 반영해 '[삭제된 메시지]' 로 표시한다.
 */
@Injectable()
export class SavedService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 메시지가 호출자에게 가시(채널 READ ACL 통과)한지 확인한다. 비가시면
   * MESSAGE_NOT_FOUND(404) 로 거부해 존재 자체를 누출하지 않는다(me-mentions 와 동일
   * 중립 정책). 삭제된(deletedAt) 원본/채널은 저장 대상이 아니므로 함께 404.
   *
   * S51 리뷰(reviewer BLOCKER-1 · security HIGH) fix-forward — ChannelAccessGuard
   * 와 정합하는 통합 ACL. 종전 코드는 (a) `c.isPrivate=false` 단락이 **워크스페이스
   * 멤버십을 검사하지 않아** 비멤버가 타 워크스페이스 공개 채널 메시지를 저장/열람
   * (크로스워크스페이스 IDOR), (b) `OR wm.role='OWNER'` 단락이 **DM(DIRECT) 에도
   * 적용**돼 비참여 OWNER 가 DM 메시지를 저장(프라이버시 우회)했다. 수정:
   *   - 워크스페이스 채널(workspaceId NOT NULL): WorkspaceMember 여야 하고
   *     (공개 OR OWNER(비-DIRECT) OR READ override fold) 통과.
   *   - DM 채널(workspaceId NULL): USER override READ 만(OWNER 단락 없음 —
   *     ChannelAccessGuard 의 DIRECT 격리와 동일). ROLE override 는 멤버일 때만.
   */
  private async assertMessageVisible(userId: string, messageId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ visible: boolean }>>`
      SELECT (
        (c."isPrivate" = false AND wm."userId" IS NOT NULL)
        OR (wm.role = 'OWNER' AND c.type <> 'DIRECT')
        OR COALESCE(
             (SELECT (bit_or(cpo."allowMask") & ~bit_or(cpo."denyMask")) & 1
                FROM "ChannelPermissionOverride" cpo
               WHERE cpo."channelId" = c.id
                 AND (
                   (cpo."principalType" = 'USER' AND cpo."principalId" = ${userId}::text)
                   OR (wm."userId" IS NOT NULL
                       AND cpo."principalType" = 'ROLE' AND cpo."principalId" = wm.role::text)
                 )),
             0
           ) > 0
      ) AS visible
      FROM "Message" m
      JOIN "Channel" c ON c.id = m."channelId" AND c."deletedAt" IS NULL
      LEFT JOIN "WorkspaceMember" wm
        ON wm."workspaceId" = c."workspaceId"
       AND wm."userId" = ${userId}::uuid
      WHERE m.id = ${messageId}::uuid
        AND m."deletedAt" IS NULL
    `;
    const row = rows[0];
    if (!row || row.visible !== true) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    }
  }

  /**
   * POST /me/saved/:messageId — 메시지를 개인 저장함에 저장(idempotent).
   *   - 메시지 가시성(READ ACL) 확인 — 접근 불가 채널 메시지 저장 차단(404).
   *   - 저장 전 카운트가 SAVED_LIMIT(500) 이상이면 422 SAVED_LIMIT_EXCEEDED.
   *   - 이미 있으면(@@unique) 현재 행을 그대로 반환(에러 아님).
   */
  async save(userId: string, messageId: string): Promise<SaveToggleResponse> {
    const existing = await this.prisma.savedMessage.findUnique({
      where: { userId_messageId: { userId, messageId } },
      select: { id: true, status: true },
    });
    if (existing) {
      return { saved: true, savedMessageId: existing.id, status: existing.status };
    }
    // 가시성 확인은 신규 저장 경로에서만(이미 저장된 행은 과거에 통과했으므로 재검사 불요).
    await this.assertMessageVisible(userId, messageId);
    // soft 한도(±1 drift 허용 — advisory lock 불요). 저장 전 카운트가 한도 이상이면 거부.
    const count = await this.prisma.savedMessage.count({ where: { userId } });
    if (count >= SAVED_LIMIT) {
      throw new DomainError(
        ErrorCode.SAVED_LIMIT_EXCEEDED,
        `개인 저장함은 최대 ${SAVED_LIMIT}개까지 저장할 수 있습니다`,
      );
    }
    try {
      const created = await this.prisma.savedMessage.create({
        data: { userId, messageId },
        select: { id: true, status: true },
      });
      return { saved: true, savedMessageId: created.id, status: created.status };
    } catch (e) {
      // @@unique race(동시 저장) — 멱등하게 현재 행을 반환한다.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await this.prisma.savedMessage.findUnique({
          where: { userId_messageId: { userId, messageId } },
          select: { id: true, status: true },
        });
        if (row) return { saved: true, savedMessageId: row.id, status: row.status };
      }
      throw e;
    }
  }

  /**
   * DELETE /me/saved/:messageId — 저장 해제(idempotent). 본인 행만 영향을 주며,
   * 행이 없어도 200(이미 해제됨)으로 멱등 처리한다.
   */
  async unsave(userId: string, messageId: string): Promise<SaveToggleResponse> {
    await this.prisma.savedMessage.deleteMany({ where: { userId, messageId } });
    return { saved: false, savedMessageId: null, status: null };
  }

  /**
   * GET /me/saved/count — IN_PROGRESS 카운트(사이드바 "저장됨" 배지).
   */
  async countInProgress(userId: string): Promise<number> {
    return this.prisma.savedMessage.count({
      where: { userId, status: 'IN_PROGRESS' },
    });
  }

  /**
   * GET /me/saved — 커서 기반 목록(savedAt DESC + id tie-break). status 필터(기본
   * IN_PROGRESS). 원본 message 요약(excerpt ≤150자 + author + channel)만 조인한다.
   * before 커서는 `${savedAtISO}|${id}` 형식의 opaque 토큰이며, 그보다 오래된
   * (savedAt, id) 튜플을 반환한다.
   */
  async list(args: {
    userId: string;
    status: SaveStatus;
    limit: number;
    before?: string;
  }): Promise<SavedMessageListResponse> {
    const limit = Math.max(1, Math.min(100, args.limit));
    const cursor = args.before ? this.decodeCursor(args.before) : null;
    // limit+1 로 한 건 더 읽어 다음 페이지 존재 여부를 판단한다.
    const rows = await this.prisma.$queryRaw<SavedRow[]>`
      SELECT
        sm.id                AS "id",
        sm."messageId"       AS "messageId",
        sm.status            AS "status",
        sm."savedAt"         AS "savedAt",
        sm."messageDeletedAt" AS "messageDeletedAt",
        LEFT(m."contentPlain", ${EXCERPT_LEN}::int) AS "excerpt",
        m."authorId"         AS "authorId",
        m."channelId"        AS "channelId",
        COALESCE(c."displayName", c."name") AS "channelName"
      FROM "SavedMessage" sm
      JOIN "Message" m ON m.id = sm."messageId"
      -- S51 리뷰(security MED): soft-delete 된 채널의 메시지 본문/채널명이
      -- 저장 목록에 잔존 노출되지 않도록 deletedAt 필터(권한 회수 후 재검사는
      -- 크로스컷팅 carryover — S49 FINDING-1 계열).
      JOIN "Channel" c ON c.id = m."channelId" AND c."deletedAt" IS NULL
      WHERE sm."userId" = ${args.userId}::uuid
        AND sm.status = ${args.status}::"SaveStatus"
        ${
          cursor
            ? Prisma.sql`AND (sm."savedAt", sm.id) < (${cursor.savedAt}::timestamptz, ${cursor.id}::uuid)`
            : Prisma.empty
        }
      ORDER BY sm."savedAt" DESC, sm.id DESC
      LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items: SavedMessageDto[] = page.map((r) => this.toDto(r));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? this.encodeCursor(last.savedAt, last.id) : null;
    return { items, nextCursor };
  }

  private toDto(r: SavedRow): SavedMessageDto {
    const deleted = r.messageDeletedAt !== null;
    return {
      id: r.id,
      messageId: r.messageId,
      status: r.status,
      savedAt: r.savedAt.toISOString(),
      messageDeletedAt: r.messageDeletedAt ? r.messageDeletedAt.toISOString() : null,
      // 삭제된 원본은 본문을 누출하지 않고 placeholder 로 마스킹한다.
      excerpt: deleted ? DELETED_PLACEHOLDER : (r.excerpt ?? ''),
      authorId: r.authorId,
      channelId: r.channelId,
      channelName: r.channelName ?? '',
    };
  }

  private encodeCursor(savedAt: Date, id: string): string {
    return Buffer.from(`${savedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(token: string): { savedAt: string; id: string } {
    try {
      const decoded = Buffer.from(token, 'base64url').toString('utf8');
      const idx = decoded.lastIndexOf('|');
      if (idx < 0) throw new Error('malformed');
      const savedAt = decoded.slice(0, idx);
      const id = decoded.slice(idx + 1);
      if (!savedAt || !id) throw new Error('malformed');
      return { savedAt, id };
    } catch {
      throw new DomainError(ErrorCode.MESSAGE_CURSOR_INVALID, 'invalid saved cursor');
    }
  }
}
