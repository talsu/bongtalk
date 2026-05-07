import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { Permission } from '../auth/permissions';

/**
 * task-046 iter6 (N1, N2, N3): thread follow / 구독 service.
 *
 * 한 user 가 한 thread (root 메시지) 를 follow.
 *
 * **N1 toggle**: subscribe / unsubscribe — POST/DELETE 동시
 * **N2 알림 분기**: dispatcher 가 listFollowers(threadParentId) 로 lookup
 * **N3 자동 follow**: messages.service 가 root/reply 생성 후 호출
 *
 * task-047 iter0 (HIGH-046-A carry-over): subscribe() 가 channel READ
 * 검증 추가. 임의의 사용자가 root UUID 만 알면 channel access 없이
 * 알림 받기 가능했던 bypass 차단. 실패 시 CHANNEL_NOT_FOUND (존재
 * leak 방지) — getGroupMembers 와 동일 패턴.
 */
@Injectable()
export class ThreadSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  /**
   * 사용자가 thread 를 follow. 이미 follow 중이면 idempotent (no-op).
   * threadParentId 는 parentMessageId === null 인 root 메시지 ID 여야 함.
   *
   * task-047 iter0: caller 가 root 가 속한 channel 의 READ 권한이 없으면
   * CHANNEL_NOT_FOUND 반환 (존재 leak 방지). 자동 follow 가 tx 로 호출
   * 시에도 이 검증은 그대로 동작 — root 가 자기가 보낸 메시지면 자기가
   * 그 channel 멤버인 게 자명해서 통과.
   */
  async subscribe(args: {
    userId: string;
    threadParentId: string;
    /** transaction client 주입 — 자동 follow path 가 동일 tx 안에서 호출 */
    tx?: Pick<PrismaClient, 'message' | 'threadSubscription'>;
  }): Promise<{ subscribed: true; createdAt: Date }> {
    const client = args.tx ?? this.prisma;
    // root 인지 검증 + channel meta 확보
    const msg = await client.message.findUnique({
      where: { id: args.threadParentId },
      select: {
        id: true,
        parentMessageId: true,
        deletedAt: true,
        channel: {
          select: { id: true, workspaceId: true, isPrivate: true, deletedAt: true },
        },
      },
    });
    if (!msg || msg.deletedAt || !msg.channel || msg.channel.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if (msg.parentMessageId !== null) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'cannot subscribe to a reply — use the thread root',
      );
    }
    // task-047 iter0 (HIGH-046-A): channel READ 검증.
    // CHANNEL_NOT_FOUND 으로 leak 방지 (resolveEffective 자체 throw 인
    // WORKSPACE_NOT_MEMBER / CHANNEL_NOT_VISIBLE 도 모두 동일 처리).
    let effective: number;
    try {
      effective = await this.channelAccess.resolveEffective(
        {
          id: msg.channel.id,
          workspaceId: msg.channel.workspaceId,
          isPrivate: msg.channel.isPrivate,
        },
        args.userId,
      );
    } catch {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if ((effective & Permission.READ) !== Permission.READ) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    const existing = await client.threadSubscription.findUnique({
      where: {
        userId_threadParentId: {
          userId: args.userId,
          threadParentId: args.threadParentId,
        },
      },
      select: { createdAt: true },
    });
    if (existing) {
      return { subscribed: true, createdAt: existing.createdAt };
    }
    const row = await client.threadSubscription.create({
      data: { userId: args.userId, threadParentId: args.threadParentId },
      select: { createdAt: true },
    });
    return { subscribed: true, createdAt: row.createdAt };
  }

  async unsubscribe(args: {
    userId: string;
    threadParentId: string;
  }): Promise<{ subscribed: false }> {
    await this.prisma.threadSubscription
      .delete({
        where: {
          userId_threadParentId: {
            userId: args.userId,
            threadParentId: args.threadParentId,
          },
        },
      })
      .catch(() => undefined);
    return { subscribed: false };
  }

  async isSubscribed(userId: string, threadParentId: string): Promise<boolean> {
    const row = await this.prisma.threadSubscription.findUnique({
      where: { userId_threadParentId: { userId, threadParentId } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * dispatcher 호출용. 한 thread 의 모든 follower userId 반환. self 제외 옵션 지원.
   */
  async listFollowers(args: {
    threadParentId: string;
    excludeUserIds?: string[];
  }): Promise<string[]> {
    const rows = await this.prisma.threadSubscription.findMany({
      where: {
        threadParentId: args.threadParentId,
        ...(args.excludeUserIds && args.excludeUserIds.length > 0
          ? { NOT: { userId: { in: args.excludeUserIds } } }
          : {}),
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
