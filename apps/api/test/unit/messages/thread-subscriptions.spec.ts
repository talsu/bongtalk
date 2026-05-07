import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadSubscriptionsService } from '../../../src/messages/thread-subscriptions.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const REPLY = '33333333-3333-4333-8333-333333333333';

function makeSvc({
  msgFindUnique,
  subFindUnique,
  subCreate,
  subDelete,
  subFindMany,
}: {
  msgFindUnique?: ReturnType<typeof vi.fn>;
  subFindUnique?: ReturnType<typeof vi.fn>;
  subCreate?: ReturnType<typeof vi.fn>;
  subDelete?: ReturnType<typeof vi.fn>;
  subFindMany?: ReturnType<typeof vi.fn>;
} = {}) {
  const prisma = {
    message: { findUnique: msgFindUnique ?? vi.fn() },
    threadSubscription: {
      findUnique: subFindUnique ?? vi.fn().mockResolvedValue(null),
      create:
        subCreate ?? vi.fn().mockResolvedValue({ createdAt: new Date('2025-01-01T00:00:00Z') }),
      delete: subDelete ?? vi.fn().mockResolvedValue({}),
      findMany: subFindMany ?? vi.fn().mockResolvedValue([]),
    },
  } as unknown as ConstructorParameters<typeof ThreadSubscriptionsService>[0];
  return new ThreadSubscriptionsService(prisma);
}

describe('ThreadSubscriptionsService.subscribe (task-046 N1)', () => {
  it('root 메시지가 없으면 MESSAGE_NOT_FOUND', async () => {
    const svc = makeSvc({ msgFindUnique: vi.fn().mockResolvedValue(null) });
    await expect(svc.subscribe({ userId: ME, threadParentId: ROOT })).rejects.toThrow(
      /thread root not found/,
    );
  });

  it('soft-deleted root 도 not found', async () => {
    const svc = makeSvc({
      msgFindUnique: vi
        .fn()
        .mockResolvedValue({ id: ROOT, parentMessageId: null, deletedAt: new Date() }),
    });
    await expect(svc.subscribe({ userId: ME, threadParentId: ROOT })).rejects.toThrow(
      /thread root not found/,
    );
  });

  it('reply 에 subscribe 시 VALIDATION_FAILED', async () => {
    const svc = makeSvc({
      msgFindUnique: vi
        .fn()
        .mockResolvedValue({ id: REPLY, parentMessageId: ROOT, deletedAt: null }),
    });
    await expect(svc.subscribe({ userId: ME, threadParentId: REPLY })).rejects.toThrow(
      /cannot subscribe to a reply/,
    );
  });

  it('이미 follow 중이면 idempotent (subscribed: true 그대로)', async () => {
    const subCreate = vi.fn();
    const svc = makeSvc({
      msgFindUnique: vi
        .fn()
        .mockResolvedValue({ id: ROOT, parentMessageId: null, deletedAt: null }),
      subFindUnique: vi.fn().mockResolvedValue({ createdAt: new Date('2025-01-01T00:00:00Z') }),
      subCreate,
    });
    const r = await svc.subscribe({ userId: ME, threadParentId: ROOT });
    expect(r.subscribed).toBe(true);
    expect(subCreate).not.toHaveBeenCalled();
  });

  it('신규 follow 시 row 생성', async () => {
    const subCreate = vi.fn().mockResolvedValue({ createdAt: new Date('2025-01-01T00:00:00Z') });
    const svc = makeSvc({
      msgFindUnique: vi
        .fn()
        .mockResolvedValue({ id: ROOT, parentMessageId: null, deletedAt: null }),
      subFindUnique: vi.fn().mockResolvedValue(null),
      subCreate,
    });
    const r = await svc.subscribe({ userId: ME, threadParentId: ROOT });
    expect(r.subscribed).toBe(true);
    expect(subCreate).toHaveBeenCalledOnce();
  });
});

describe('ThreadSubscriptionsService.unsubscribe', () => {
  it('정상 delete', async () => {
    const subDelete = vi.fn().mockResolvedValue({});
    const svc = makeSvc({ subDelete });
    const r = await svc.unsubscribe({ userId: ME, threadParentId: ROOT });
    expect(r.subscribed).toBe(false);
    expect(subDelete).toHaveBeenCalledOnce();
  });

  it('row 없어도 idempotent (catch swallow)', async () => {
    const subDelete = vi.fn().mockRejectedValue(new Error('not found'));
    const svc = makeSvc({ subDelete });
    const r = await svc.unsubscribe({ userId: ME, threadParentId: ROOT });
    expect(r.subscribed).toBe(false);
  });
});

describe('ThreadSubscriptionsService.isSubscribed', () => {
  it('row 존재 → true', async () => {
    const svc = makeSvc({
      subFindUnique: vi.fn().mockResolvedValue({ id: 'sub-1' }),
    });
    expect(await svc.isSubscribed(ME, ROOT)).toBe(true);
  });

  it('row 없음 → false', async () => {
    const svc = makeSvc({
      subFindUnique: vi.fn().mockResolvedValue(null),
    });
    expect(await svc.isSubscribed(ME, ROOT)).toBe(false);
  });
});

describe('ThreadSubscriptionsService.listFollowers (task-046 N2)', () => {
  it('모든 follower userId 반환', async () => {
    const svc = makeSvc({
      subFindMany: vi
        .fn()
        .mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]),
    });
    expect(await svc.listFollowers({ threadParentId: ROOT })).toEqual(['u1', 'u2', 'u3']);
  });

  it('excludeUserIds 가 있으면 NOT IN clause 적용', async () => {
    const subFindMany = vi.fn().mockResolvedValue([{ userId: 'u2' }]);
    const svc = makeSvc({ subFindMany });
    await svc.listFollowers({ threadParentId: ROOT, excludeUserIds: ['u1', 'u3'] });
    const where = subFindMany.mock.calls[0][0].where;
    expect(where.NOT).toEqual({ userId: { in: ['u1', 'u3'] } });
  });
});
