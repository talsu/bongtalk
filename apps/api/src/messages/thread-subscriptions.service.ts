import { Injectable } from '@nestjs/common';
import { Prisma, ThreadNotificationLevel, type PrismaClient } from '@prisma/client';
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
 *
 * S34 fix-forward (BLOCKER #1 tx-poisoning): subscribe() 의 create 경로를
 * findUnique 선검사 + create 에서 `INSERT … ON CONFLICT DO NOTHING` 으로
 * 전환했습니다. 종전 구현은 동시 호출 시 unique `(userId, threadParentId)`
 * 위반(23505)을 발생시켰는데, Postgres 에서 제약 위반은 **트랜잭션 전체를
 * abort** 시킵니다. send tx 의 자동 follow / @멘션 자동 구독 호출부가
 * `.catch(() => undefined)` 로 감싸도, 그것은 JS 예외만 삼킬 뿐 이미 abort 된
 * 트랜잭션은 되돌리지 못해 후속 쿼리/commit 이 25P02(current transaction is
 * aborted) 로 줄줄이 실패합니다(self-DoS). ON CONFLICT DO NOTHING 은 제약
 * 위반 자체를 멱등 no-op 으로 흡수하므로 23505 가 발생하지 않습니다.
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
    /**
     * transaction client 주입 — 자동 follow path 가 동일 tx 안에서 호출.
     * S34 fix-forward (#1): ON CONFLICT raw INSERT 를 위해 `$executeRaw` 도
     * 포함시킵니다(tx 클라이언트의 raw 메서드는 PrismaClient 와 동형).
     */
    tx?: Pick<PrismaClient, 'message' | 'threadSubscription' | '$executeRaw'>;
  }): Promise<{ subscribed: true; createdAt: Date }> {
    const client = args.tx ?? this.prisma;
    // root 인지 검증 + channel meta 확보. tx 주입 시 같은 commit 의 방금 INSERT 한
    // 루트도 보이도록 `client`(tx 일 수 있음)로 조회한다 — assertThreadRootReadable
    // (this.prisma 고정)을 쓰지 않는 이유. ACL 판정 로직은 그 헬퍼와 동일하다.
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
    // S34 fix-forward (#1): findUnique 선검사 + create 대신 멱등 INSERT.
    // ON CONFLICT DO NOTHING 은 이미 구독 중이면 no-op(0행 영향)이고, 신규면
    // 1행을 삽입합니다 — 제약 위반(23505)이 발생하지 않으므로 동시 구독에도
    // tx 가 abort 되지 않습니다. `id`/`createdAt` 은 스키마 default 를 그대로
    // 사용합니다(gen_random_uuid() / now()).
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "ThreadSubscription" ("id", "userId", "threadParentId", "createdAt")
      VALUES (gen_random_uuid(), ${args.userId}::uuid, ${args.threadParentId}::uuid, now())
      ON CONFLICT ("userId", "threadParentId") DO NOTHING
    `);
    // INSERT(또는 기존 행) 후 권위 createdAt 을 읽어 돌려줍니다. ON CONFLICT
    // DO NOTHING 은 충돌 시 RETURNING 이 비므로, 멱등 보장(항상 1행 존재)을
    // 활용해 select 로 확정 값을 가져옵니다.
    const row = await client.threadSubscription.findUnique({
      where: {
        userId_threadParentId: {
          userId: args.userId,
          threadParentId: args.threadParentId,
        },
      },
      select: { createdAt: true },
    });
    // 방금 INSERT 했거나 이미 존재하므로 row 는 정상 경로에서 항상 non-null.
    // 극히 드문 동시 삭제 레이스(INSERT 직후 다른 tx 가 삭제)에 대비해
    // 현재 시각으로 폴백한다 — subscribed 계약(true)은 유지.
    return { subscribed: true, createdAt: row?.createdAt ?? new Date() };
  }

  /**
   * S38 (FR-TH-08): 스레드 알림 레벨 설정(+ 수동 구독). 벨 드롭다운에서 ALL /
   * MENTIONS / OFF 를 고르면 호출된다. 구독 행이 없으면 새로 INSERT(수동 구독 —
   * 구독 없던 사용자도 ALL 로 켤 수 있어야 한다는 FR-TH-08), 있으면 레벨만 UPDATE
   * 한다(멱등 upsert).
   *
   * subscribe() 와 동일한 채널 READ ACL 을 강제한다 — 임의 root UUID 로 타 채널
   * 스레드의 구독 레벨을 바꾸는 IDOR 을 차단한다(실패 시 MESSAGE_NOT_FOUND 로
   * 존재 leak 방지). 자동 구독(send tx)과 달리 이 경로는 사용자 명시 액션이라
   * 항상 ACL 을 통과시킨다.
   */
  async setNotificationLevel(args: {
    userId: string;
    threadParentId: string;
    notificationLevel: ThreadNotificationLevel;
  }): Promise<{ subscribed: true; notificationLevel: ThreadNotificationLevel }> {
    await this.assertThreadRootReadable(args.userId, args.threadParentId);
    // 멱등 upsert: 구독 행이 없으면 지정 레벨로 INSERT(수동 구독), 있으면 레벨만
    // UPDATE. unique (userId, threadParentId) 충돌을 ON CONFLICT 로 흡수해 동시
    // 호출에도 tx abort(23505)가 없다(subscribe 와 동일 멱등 패턴).
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ThreadSubscription" ("id", "userId", "threadParentId", "notificationLevel", "createdAt")
      VALUES (gen_random_uuid(), ${args.userId}::uuid, ${args.threadParentId}::uuid,
              ${args.notificationLevel}::"ThreadNotificationLevel", now())
      ON CONFLICT ("userId", "threadParentId") DO UPDATE
        SET "notificationLevel" = EXCLUDED."notificationLevel"
    `);
    return { subscribed: true, notificationLevel: args.notificationLevel };
  }

  /**
   * subscribe() 의 채널 READ ACL 검증을 단일 출처로 추출. 루트 메시지가 존재하고
   * (비삭제·채널 비삭제) 호출자가 그 채널 READ 권한이 있으며 root(=parentMessageId
   * null)인지 확인한다. 실패는 전부 MESSAGE_NOT_FOUND(존재 leak 방지) 또는
   * VALIDATION_FAILED(답글에 호출)로 수렴한다.
   */
  private async assertThreadRootReadable(userId: string, threadParentId: string): Promise<void> {
    const msg = await this.prisma.message.findUnique({
      where: { id: threadParentId },
      select: {
        id: true,
        parentMessageId: true,
        deletedAt: true,
        channel: {
          // S38 fix-forward (보안 LOW): archived 채널 스레드의 알림 레벨 변경(수동
          // 구독)을 막기 위해 archivedAt 을 함께 로드한다(resolveThreadRootForAcl 의
          // CHANNEL_ARCHIVED 패턴과 일관). 보관 채널은 GET/ack 가 막히므로 구독
          // 레벨 변경도 차단한다.
          select: {
            id: true,
            workspaceId: true,
            isPrivate: true,
            archivedAt: true,
            deletedAt: true,
          },
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
    let effective: number;
    try {
      effective = await this.channelAccess.resolveEffective(
        {
          id: msg.channel.id,
          workspaceId: msg.channel.workspaceId,
          isPrivate: msg.channel.isPrivate,
        },
        userId,
      );
    } catch {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if ((effective & Permission.READ) !== Permission.READ) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    // READ 통과 뒤 archived 검사(존재 leak 없이 409 로 수렴 — get/ack 와 동일).
    if (msg.channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived — unarchive first');
    }
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
