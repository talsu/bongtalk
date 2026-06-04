import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { TempEvictProcessor } from '../../../src/queue/temp-evict.processor';
import { TempEvictQueueService } from '../../../src/queue/temp-evict-queue.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import { MEMBER_LEFT } from '../../../src/workspaces/events/workspace-events';
import {
  tempEvictJobId,
  tempEvictSocketsKey,
  TEMP_EVICT_DEBOUNCE_MS,
} from '../../../src/queue/temp-evict-queue.constants';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOCKET_A = 'sock-a';
const SOCKET_B = 'sock-b';

type FakeRedis = {
  sadd: ReturnType<typeof vi.fn>;
  srem: ReturnType<typeof vi.fn>;
  scard: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  _store: Map<string, Set<string>>;
};

function makeRedis(): FakeRedis {
  const store = new Map<string, Set<string>>();
  return {
    _store: store,
    sadd: vi.fn(async (key: string, member: string) => {
      const set = store.get(key) ?? new Set<string>();
      set.add(member);
      store.set(key, set);
      return 1;
    }),
    srem: vi.fn(async (key: string, member: string) => {
      store.get(key)?.delete(member);
      return 1;
    }),
    scard: vi.fn(async (key: string) => store.get(key)?.size ?? 0),
    expire: vi.fn(async () => 1),
  };
}

type FakeQueue = {
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  _jobs: Set<string>;
};

function makeQueue(): FakeQueue {
  const jobs = new Set<string>();
  return {
    _jobs: jobs,
    add: vi.fn(async (_name: string, _data: unknown, opts: { jobId: string; delay: number }) => {
      jobs.add(opts.jobId);
      return { id: opts.jobId };
    }),
    remove: vi.fn(async (jobId: string) => {
      jobs.delete(jobId);
      return 1;
    }),
  };
}

function makeService(redis: FakeRedis, queue: FakeQueue): TempEvictQueueService {
  return new TempEvictQueueService(
    queue as unknown as ConstructorParameters<typeof TempEvictQueueService>[0],
    redis as unknown as ConstructorParameters<typeof TempEvictQueueService>[1],
  );
}

describe('S70 TempEvictQueueService — Redis Set + BullMQ debounce', () => {
  it('connect 시 socketId SADD + 기존 강퇴 잡 remove(취소)합니다', async () => {
    const redis = makeRedis();
    const queue = makeQueue();
    queue._jobs.add(tempEvictJobId(USER, WS)); // 이전에 arm 된 잡이 있다고 가정.
    const svc = makeService(redis, queue);

    await svc.onSocketConnect({ userId: USER, workspaceId: WS, socketId: SOCKET_A });

    expect(redis._store.get(tempEvictSocketsKey(USER, WS))?.has(SOCKET_A)).toBe(true);
    expect(queue.remove).toHaveBeenCalledWith(tempEvictJobId(USER, WS));
    expect(queue._jobs.has(tempEvictJobId(USER, WS))).toBe(false); // 재연결로 취소됨.
  });

  it('마지막 소켓 disconnect(SCARD 0) 시 2초 debounce 강퇴 잡을 arm 합니다', async () => {
    const redis = makeRedis();
    const queue = makeQueue();
    const svc = makeService(redis, queue);
    await svc.onSocketConnect({ userId: USER, workspaceId: WS, socketId: SOCKET_A });

    await svc.onSocketDisconnect({ userId: USER, workspaceId: WS, socketId: SOCKET_A });

    expect(queue.add).toHaveBeenCalledOnce();
    const addArgs = queue.add.mock.calls[0];
    expect(addArgs[2]).toMatchObject({
      jobId: tempEvictJobId(USER, WS),
      delay: TEMP_EVICT_DEBOUNCE_MS,
    });
  });

  it('다중기기: 한 소켓 disconnect 여도 다른 소켓이 남아있으면(SCARD>0) 강퇴를 arm 하지 않습니다', async () => {
    const redis = makeRedis();
    const queue = makeQueue();
    const svc = makeService(redis, queue);
    await svc.onSocketConnect({ userId: USER, workspaceId: WS, socketId: SOCKET_A });
    await svc.onSocketConnect({ userId: USER, workspaceId: WS, socketId: SOCKET_B });

    await svc.onSocketDisconnect({ userId: USER, workspaceId: WS, socketId: SOCKET_A });

    expect(queue.add).not.toHaveBeenCalled(); // SOCKET_B 잔존 → 미실행.
  });

  it('Redis 부재 시 disconnect 가 강퇴를 arm 하지 않습니다(집계 불가 → 안전 미실행)', async () => {
    const queue = makeQueue();
    const svc = new TempEvictQueueService(
      queue as unknown as ConstructorParameters<typeof TempEvictQueueService>[0],
      undefined,
    );
    await svc.onSocketDisconnect({ userId: USER, workspaceId: WS, socketId: SOCKET_A });
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('S70 TempEvictProcessor — SCARD 재확인 게이트', () => {
  function makeJob() {
    return { data: { userId: USER, workspaceId: WS } } as unknown as Parameters<
      TempEvictProcessor['process']
    >[0];
  }

  it('SCARD>0(2초 내 재연결/다른 기기) 이면 강퇴하지 않습니다', async () => {
    const prisma = {
      workspaceMember: { findUnique: vi.fn(), delete: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as PrismaService;
    const outbox = { record: vi.fn() } as unknown as OutboxService;
    const evict = {
      activeSocketCount: vi.fn().mockResolvedValue(1),
    } as unknown as TempEvictQueueService;
    const proc = new TempEvictProcessor(prisma, outbox, evict);

    await proc.process(makeJob());

    expect(
      (prisma as unknown as { workspaceMember: { findUnique: ReturnType<typeof vi.fn> } })
        .workspaceMember.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).not.toHaveBeenCalled();
  });

  it('영구 멤버(isTemporary=false)는 강퇴하지 않습니다', async () => {
    const txn = vi.fn();
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ isTemporary: false }) },
      $transaction: txn,
    } as unknown as PrismaService;
    const outbox = { record: vi.fn() } as unknown as OutboxService;
    const evict = {
      activeSocketCount: vi.fn().mockResolvedValue(0),
    } as unknown as TempEvictQueueService;
    const proc = new TempEvictProcessor(prisma, outbox, evict);

    await proc.process(makeJob());

    expect(txn).not.toHaveBeenCalled();
  });

  it('SCARD 0 + 임시 멤버이면 삭제 + MEMBER_LEFT(reason=temp_expired) outbox 를 남깁니다', async () => {
    const recordedEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const tx = {
      workspaceMember: { delete: vi.fn().mockResolvedValue(undefined) },
    };
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ isTemporary: true }) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = {
      record: vi.fn(
        async (_tx: unknown, input: { eventType: string; payload: Record<string, unknown> }) => {
          recordedEvents.push({ eventType: input.eventType, payload: input.payload });
          return 'id';
        },
      ),
    } as unknown as OutboxService;
    const evict = {
      activeSocketCount: vi.fn().mockResolvedValue(0),
    } as unknown as TempEvictQueueService;
    const proc = new TempEvictProcessor(prisma, outbox, evict);

    await proc.process(makeJob());

    expect(tx.workspaceMember.delete).toHaveBeenCalledOnce();
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].eventType).toBe(MEMBER_LEFT);
    expect(recordedEvents[0].payload).toMatchObject({
      workspaceId: WS,
      userId: USER,
      reason: 'temp_expired',
    });
  });

  it('동시 leave/kick 으로 행이 이미 사라지면(P2025) 멱등 skip 합니다', async () => {
    const tx = {
      workspaceMember: {
        delete: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('not found', {
            code: 'P2025',
            clientVersion: 'x',
          }),
        ),
      },
    };
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ isTemporary: true }) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = { record: vi.fn() } as unknown as OutboxService;
    const evict = {
      activeSocketCount: vi.fn().mockResolvedValue(0),
    } as unknown as TempEvictQueueService;
    const proc = new TempEvictProcessor(prisma, outbox, evict);

    await expect(proc.process(makeJob())).resolves.toBeUndefined();
  });
});
