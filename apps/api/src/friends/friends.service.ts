import { Injectable } from '@nestjs/common';
import { Prisma, FriendshipStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';

export const FRIEND_REQUEST_RECEIVED = 'friend.request.received';
export const FRIEND_REQUEST_ACCEPTED = 'friend.request.accepted';

export type FriendsFilter = 'accepted' | 'pending_incoming' | 'pending_outgoing' | 'blocked';

export interface FriendRow {
  friendshipId: string;
  otherUserId: string;
  otherUsername: string;
  status: FriendshipStatus;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

const FRIEND_CAP = 1000;

/**
 * task-032-B: Friendship CRUD. Directed row (requester→addressee) but
 * ACCEPTED relationships read as symmetric via OR in WHERE. BLOCKED
 * is always owned by the blocker (the requester column), so unblock
 * just updates the same row.
 */
@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  private async findRow(userA: string, userB: string) {
    return this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userA, addresseeId: userB },
          { requesterId: userB, addresseeId: userA },
        ],
      },
    });
  }

  async requestByUsername(meId: string, targetUsername: string) {
    const target = await this.prisma.user.findUnique({
      where: { username: targetUsername },
      select: { id: true, username: true },
    });
    if (!target) throw new DomainError(ErrorCode.FRIEND_TARGET_NOT_FOUND, 'user not found');
    if (target.id === meId) {
      throw new DomainError(ErrorCode.FRIEND_CANNOT_SELF, 'cannot friend yourself');
    }
    const existing = await this.findRow(meId, target.id);
    if (existing) {
      if (existing.status === 'BLOCKED') {
        throw new DomainError(ErrorCode.FRIEND_BLOCKED, 'blocked');
      }
      if (existing.status === 'ACCEPTED') {
        throw new DomainError(ErrorCode.FRIEND_ALREADY, 'already friends');
      }
      // PENDING from the other side → auto-accept so no duplicate rows.
      if (existing.addresseeId === meId) {
        // Auto-accept the existing request from the other side.
        return this.prisma.$transaction(async (tx) => {
          const updated = await tx.friendship.update({
            where: { id: existing.id },
            data: { status: 'ACCEPTED' },
          });
          await this.outbox.record(tx, {
            aggregateType: 'friendship',
            aggregateId: updated.id,
            eventType: FRIEND_REQUEST_ACCEPTED,
            payload: {
              friendshipId: updated.id,
              requesterId: updated.requesterId,
              addresseeId: updated.addresseeId,
            },
          });
          return updated;
        });
      }
      throw new DomainError(ErrorCode.FRIEND_REQUEST_DUPLICATE, 'already requested');
    }
    // task-037-C (closes 032-follow-cap-atomicity): count + create
    // inside a single Serializable transaction so concurrent requests
    // can't both pass the check and exceed the cap by one. Postgres
    // upgrades the snapshot on first read, so a second tx that tries
    // to read past this point will serialise behind the first.
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const acceptedCount = await tx.friendship.count({
            where: {
              status: 'ACCEPTED',
              OR: [{ requesterId: meId }, { addresseeId: meId }],
            },
          });
          if (acceptedCount >= FRIEND_CAP) {
            throw new DomainError(ErrorCode.FRIEND_CAP_REACHED, `friend cap ${FRIEND_CAP} reached`);
          }
          const row = await tx.friendship.create({
            data: { requesterId: meId, addresseeId: target.id, status: 'PENDING' },
          });
          await this.outbox.record(tx, {
            aggregateType: 'friendship',
            aggregateId: row.id,
            eventType: FRIEND_REQUEST_RECEIVED,
            payload: {
              friendshipId: row.id,
              requesterId: meId,
              addresseeId: target.id,
              requesterUsername: target.username,
            },
          });
          return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Lost race — re-read and return current state.
        const row = await this.findRow(meId, target.id);
        if (row) return row;
      }
      throw e;
    }
  }

  async accept(meId: string, friendshipId: string) {
    const row = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    if (!row) throw new DomainError(ErrorCode.FRIEND_NOT_FOUND, 'friendship not found');
    if (row.addresseeId !== meId || row.status !== 'PENDING') {
      throw new DomainError(ErrorCode.FRIEND_INVALID_STATE, 'cannot accept');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.friendship.update({
        where: { id: friendshipId },
        data: { status: 'ACCEPTED' },
      });
      await this.outbox.record(tx, {
        aggregateType: 'friendship',
        aggregateId: updated.id,
        eventType: FRIEND_REQUEST_ACCEPTED,
        payload: {
          friendshipId: updated.id,
          requesterId: updated.requesterId,
          addresseeId: updated.addresseeId,
        },
      });
      return updated;
    });
  }

  async reject(meId: string, friendshipId: string) {
    const row = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    if (!row) return; // idempotent
    if (row.addresseeId !== meId || row.status !== 'PENDING') {
      throw new DomainError(ErrorCode.FRIEND_INVALID_STATE, 'cannot reject');
    }
    await this.prisma.friendship.delete({ where: { id: friendshipId } });
  }

  async remove(meId: string, friendshipId: string) {
    const row = await this.prisma.friendship.findUnique({ where: { id: friendshipId } });
    if (!row) return;
    if (row.requesterId !== meId && row.addresseeId !== meId) {
      throw new DomainError(ErrorCode.FRIEND_NOT_FOUND, 'not a participant');
    }
    if (row.status !== 'ACCEPTED') {
      throw new DomainError(ErrorCode.FRIEND_INVALID_STATE, 'not accepted');
    }
    await this.prisma.friendship.delete({ where: { id: friendshipId } });
  }

  async block(meId: string, targetUserId: string) {
    if (meId === targetUserId) {
      throw new DomainError(ErrorCode.FRIEND_CANNOT_SELF, 'cannot block yourself');
    }
    const existing = await this.findRow(meId, targetUserId);
    if (existing) {
      // Flip row so the blocker is always the requester column.
      if (existing.requesterId === meId) {
        return this.prisma.friendship.update({
          where: { id: existing.id },
          data: { status: 'BLOCKED' },
        });
      }
      // Other side is the requester — delete their row and insert a new
      // row with me as the blocker. Single transaction so there's no
      // moment where the pair has no row. task-037-C (closes 032-follow-
      // block-flip-p2002): catch P2002 and fall back to a pure update
      // of the original row so a concurrent double-block collapses to
      // a single BLOCKED state instead of bubbling a 500.
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.friendship.delete({ where: { id: existing.id } });
          return tx.friendship.create({
            data: { requesterId: meId, addresseeId: targetUserId, status: 'BLOCKED' },
          });
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const current = await this.findRow(meId, targetUserId);
          if (current) {
            return this.prisma.friendship.update({
              where: { id: current.id },
              data: { status: 'BLOCKED' },
            });
          }
        }
        throw e;
      }
    }
    return this.prisma.friendship.create({
      data: { requesterId: meId, addresseeId: targetUserId, status: 'BLOCKED' },
    });
  }

  async unblock(meId: string, targetUserId: string) {
    const existing = await this.findRow(meId, targetUserId);
    if (!existing || existing.status !== 'BLOCKED' || existing.requesterId !== meId) {
      return;
    }
    await this.prisma.friendship.delete({ where: { id: existing.id } });
  }

  async list(meId: string, filter: FriendsFilter): Promise<FriendRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        requesterId: string;
        addresseeId: string;
        status: FriendshipStatus;
        createdAt: Date;
        otherUserId: string;
        otherUsername: string;
      }>
    >`
      SELECT
        f.id,
        f."requesterId",
        f."addresseeId",
        f.status,
        f."createdAt",
        CASE WHEN f."requesterId" = ${meId}::uuid THEN f."addresseeId" ELSE f."requesterId" END AS "otherUserId",
        u.username AS "otherUsername"
      FROM "Friendship" f
      JOIN "User" u ON u.id = CASE WHEN f."requesterId" = ${meId}::uuid THEN f."addresseeId" ELSE f."requesterId" END
      WHERE (f."requesterId" = ${meId}::uuid OR f."addresseeId" = ${meId}::uuid)
        AND (
          (${filter}::text = 'accepted' AND f.status = 'ACCEPTED')
          OR (${filter}::text = 'pending_incoming' AND f.status = 'PENDING' AND f."addresseeId" = ${meId}::uuid)
          OR (${filter}::text = 'pending_outgoing' AND f.status = 'PENDING' AND f."requesterId" = ${meId}::uuid)
          OR (${filter}::text = 'blocked' AND f.status = 'BLOCKED' AND f."requesterId" = ${meId}::uuid)
        )
      ORDER BY f."createdAt" DESC
    `;
    return rows.map((r) => ({
      friendshipId: r.id,
      otherUserId: r.otherUserId,
      otherUsername: r.otherUsername,
      status: r.status,
      direction: r.requesterId === meId ? 'outgoing' : 'incoming',
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
