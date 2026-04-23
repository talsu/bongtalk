import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { Permission } from '../../auth/permissions';

const DM_ALLOW_MASK =
  Permission.READ |
  Permission.WRITE_MESSAGE |
  Permission.DELETE_OWN_MESSAGE |
  Permission.UPLOAD_ATTACHMENT;

export interface DmListItem {
  channelId: string;
  otherUserId: string;
  otherUsername: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

/**
 * task-027-A: Direct Message channel management. DMs live in the same
 * Channel table with type=DIRECT + isPrivate=true; membership is
 * expressed as two USER-level ChannelPermissionOverride rows
 * (ALLOW READ|WRITE|DELETE_OWN|UPLOAD). Idempotent createOrGet keeps
 * the pair → channel mapping 1:1 via a deterministic name slug built
 * from the sorted userId pair.
 */
@Injectable()
export class DirectMessagesService {
  constructor(private readonly prisma: PrismaService) {}

  private channelName(a: string, b: string): string {
    const [x, y] = [a, b].sort();
    return `dm:${x}:${y}`;
  }

  async createOrGet(
    workspaceId: string,
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string; created: boolean }> {
    if (meId === otherUserId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'cannot DM yourself');
    }
    // Both users must be workspace members (task-027 contract).
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: [meId, otherUserId] } },
      select: { userId: true },
    });
    const memberSet = new Set(members.map((m) => m.userId));
    if (!memberSet.has(meId) || !memberSet.has(otherUserId)) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'target is not a workspace member');
    }

    const name = this.channelName(meId, otherUserId);
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
      select: { id: true },
    });
    if (existing) return { channelId: existing.id, created: false };

    // Transaction: new Channel + two ChannelPermissionOverride rows.
    // task-027 reviewer H1: two concurrent POSTs for the same pair race
    // the findFirst→create gap. Channel has @@unique([workspaceId, name])
    // so the loser hits P2002 on the DB; catch and re-run findFirst so
    // the caller gets the winner's channelId instead of a 500.
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const ch = await tx.channel.create({
          data: {
            workspaceId,
            name,
            type: 'DIRECT',
            isPrivate: true,
            topic: null,
            position: 0,
            categoryId: null,
          },
        });
        for (const uid of [meId, otherUserId]) {
          await tx.channelPermissionOverride.create({
            data: {
              channelId: ch.id,
              principalType: 'USER',
              principalId: uid,
              allowMask: DM_ALLOW_MASK,
              denyMask: 0,
            },
          });
        }
        return ch;
      });
      return { channelId: created.id, created: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const winner = await this.prisma.channel.findFirst({
          where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
          select: { id: true },
        });
        if (winner) return { channelId: winner.id, created: false };
      }
      throw err;
    }
  }

  async list(workspaceId: string | null, meId: string, limit = 50): Promise<DmListItem[]> {
    const capped = Math.max(1, Math.min(100, limit));
    // task-033-B: when workspaceId is null (Global DM), list every
    // DIRECT channel the caller has an ALLOW override on — regardless
    // of workspace scope. When a workspace is specified we keep the
    // original 027-scoped behaviour.
    const rows = await this.prisma.$queryRaw<
      Array<{
        channelId: string;
        otherUserId: string;
        otherUsername: string;
        lastMessageAt: Date | null;
        lastMessagePreview: string | null;
        unreadCount: bigint;
      }>
    >`
      WITH my_dms AS (
        SELECT c.id AS "channelId"
          FROM "Channel" c
          JOIN "ChannelPermissionOverride" mine
            ON mine."channelId" = c.id
           AND mine."principalType" = 'USER'
           AND mine."principalId" = ${meId}::text
           AND (mine."allowMask" & 1) > 0
         WHERE (${workspaceId}::uuid IS NULL OR c."workspaceId" = ${workspaceId}::uuid)
           AND c.type = 'DIRECT'
           AND c."deletedAt" IS NULL
      ),
      peers AS (
        SELECT md."channelId",
               peer."principalId" AS "otherUserId"
          FROM my_dms md
          JOIN "ChannelPermissionOverride" peer
            ON peer."channelId" = md."channelId"
           AND peer."principalType" = 'USER'
           AND peer."principalId" <> ${meId}::text
      ),
      last_msg AS (
        SELECT DISTINCT ON (m."channelId")
               m."channelId",
               m."createdAt",
               LEFT(m."contentPlain", 140) AS preview
          FROM "Message" m
          JOIN my_dms md ON md."channelId" = m."channelId"
         WHERE m."deletedAt" IS NULL
         ORDER BY m."channelId", m."createdAt" DESC
      )
      SELECT
        p."channelId",
        p."otherUserId",
        u.username AS "otherUsername",
        lm."createdAt" AS "lastMessageAt",
        lm.preview AS "lastMessagePreview",
        COALESCE((
          SELECT COUNT(*)::bigint
            FROM "Message" m2
            LEFT JOIN "UserChannelReadState" rs
              ON rs."userId" = ${meId}::uuid
             AND rs."channelId" = m2."channelId"
           WHERE m2."channelId" = p."channelId"
             AND m2."deletedAt" IS NULL
             AND m2."authorId" <> ${meId}::uuid
             AND (rs."lastReadAt" IS NULL OR m2."createdAt" > rs."lastReadAt")
        ), 0) AS "unreadCount"
      FROM peers p
      JOIN "User" u ON u.id = p."otherUserId"::uuid
      LEFT JOIN last_msg lm ON lm."channelId" = p."channelId"
      ORDER BY lm."createdAt" DESC NULLS LAST, u.username ASC
      LIMIT ${capped}
    `;
    return rows.map((r) => ({
      channelId: r.channelId,
      otherUserId: r.otherUserId,
      otherUsername: r.otherUsername,
      lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
      lastMessagePreview: r.lastMessagePreview,
      unreadCount: Number(r.unreadCount),
    }));
  }

  async findByUser(
    workspaceId: string | null,
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string } | null> {
    const name = this.channelName(meId, otherUserId);
    const ch = await this.prisma.channel.findFirst({
      where: {
        ...(workspaceId === null ? {} : { workspaceId }),
        name,
        type: 'DIRECT',
        deletedAt: null,
      },
      select: { id: true },
    });
    return ch ? { channelId: ch.id } : null;
  }

  /**
   * task-033-B: friend-gated Global DM. Channel.workspaceId is NULL
   * for global DMs (034-A widened the schema + 034 review added the
   * partial UNIQUE on name under that subset). Enforces ACCEPTED
   * friendship between the pair — BLOCKED or missing friendship is
   * rejected.
   */
  async createOrGetGlobal(
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string; created: boolean }> {
    if (meId === otherUserId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'cannot DM yourself');
    }
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: meId, addresseeId: otherUserId },
          { requesterId: otherUserId, addresseeId: meId },
        ],
      },
      select: { status: true },
    });
    if (!friendship || friendship.status !== 'ACCEPTED') {
      throw new DomainError(
        ErrorCode.FRIEND_NOT_FOUND,
        friendship?.status === 'BLOCKED' ? 'cannot DM: blocked' : 'cannot DM: not friends yet',
      );
    }
    // task-034-A: Channel.workspaceId is nullable now. Global DM is a
    // DIRECT channel with no workspace. Reuse the createOrGet path by
    // passing null workspaceId — the service skips the workspace-
    // member gate when workspaceId is null.
    return this.createOrGetWorkspaceless(meId, otherUserId);
  }

  private async createOrGetWorkspaceless(
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string; created: boolean }> {
    const name = this.channelName(meId, otherUserId);
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId: null, name, type: 'DIRECT', deletedAt: null },
      select: { id: true },
    });
    if (existing) return { channelId: existing.id, created: false };

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const ch = await tx.channel.create({
          data: {
            workspaceId: null,
            name,
            type: 'DIRECT',
            isPrivate: true,
            topic: null,
            position: 0,
            categoryId: null,
          },
        });
        for (const uid of [meId, otherUserId]) {
          await tx.channelPermissionOverride.create({
            data: {
              channelId: ch.id,
              principalType: 'USER',
              principalId: uid,
              allowMask: DM_ALLOW_MASK,
              denyMask: 0,
            },
          });
        }
        return ch;
      });
      return { channelId: created.id, created: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const winner = await this.prisma.channel.findFirst({
          where: { workspaceId: null, name, type: 'DIRECT', deletedAt: null },
          select: { id: true },
        });
        if (winner) return { channelId: winner.id, created: false };
      }
      throw err;
    }
  }
}
