import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * task-046 iter6 (N1, N2, N3): thread follow / 구독 service.
 *
 * 한 user 가 한 thread (root 메시지) 를 follow.
 *
 * **N1 toggle**: subscribe / unsubscribe — POST/DELETE 동시
 * **N2 알림 분기**: dispatcher 가 listFollowers(threadParentId) 로 lookup
 * **N3 자동 follow**: messages.service 가 root/reply 생성 후 호출
 */
@Injectable()
export class ThreadSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 사용자가 thread 를 follow. 이미 follow 중이면 idempotent (no-op).
   * threadParentId 는 parentMessageId === null 인 root 메시지 ID 여야 함.
   */
  async subscribe(args: {
    userId: string;
    threadParentId: string;
    /** transaction client 주입 — 자동 follow path 가 동일 tx 안에서 호출 */
    tx?: Pick<PrismaClient, 'message' | 'threadSubscription'>;
  }): Promise<{ subscribed: true; createdAt: Date }> {
    const client = args.tx ?? this.prisma;
    // root 인지 검증
    const msg = await client.message.findUnique({
      where: { id: args.threadParentId },
      select: { id: true, parentMessageId: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if (msg.parentMessageId !== null) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'cannot subscribe to a reply — use the thread root',
      );
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
