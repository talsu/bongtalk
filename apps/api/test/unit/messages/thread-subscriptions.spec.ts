import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadSubscriptionsService } from '../../../src/messages/thread-subscriptions.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const REPLY = '33333333-3333-4333-8333-333333333333';

// task-047 iter0: channel ACL guard 추가에 따른 helper 시그니처 확장.
function makeSvc({
  msgFindUnique,
  subFindUnique,
  subCreate,
  subDelete,
  subFindMany,
  effective = 0xffff, // default: full READ + 다른 모든 권한
  effectiveThrows = false,
}: {
  msgFindUnique?: ReturnType<typeof vi.fn>;
  subFindUnique?: ReturnType<typeof vi.fn>;
  subCreate?: ReturnType<typeof vi.fn>;
  subDelete?: ReturnType<typeof vi.fn>;
  subFindMany?: ReturnType<typeof vi.fn>;
  /** ChannelAccessService.resolveEffective() 의 반환 mask */
  effective?: number;
  /** resolveEffective 가 throw 하는 시나리오 (WORKSPACE_NOT_MEMBER 등) */
  effectiveThrows?: boolean;
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
  const channelAccess = {
    resolveEffective: vi.fn(async () => {
      if (effectiveThrows) throw new Error('not a workspace member');
      return effective;
    }),
    requirePermission: vi.fn(),
    requireVisibility: vi.fn(),
  } as unknown as ConstructorParameters<typeof ThreadSubscriptionsService>[1];
  return new ThreadSubscriptionsService(prisma, channelAccess);
}

// task-047 iter0: msg.findUnique 가 channel meta 도 select 하도록 helper.
function rootMsg(overrides: { isPrivate?: boolean; workspaceId?: string | null } = {}): {
  id: string;
  parentMessageId: null;
  deletedAt: null;
  channel: { id: string; workspaceId: string | null; isPrivate: boolean; deletedAt: null };
} {
  return {
    id: ROOT,
    parentMessageId: null,
    deletedAt: null,
    channel: {
      id: 'channel-1',
      workspaceId: overrides.workspaceId ?? 'ws-1',
      isPrivate: overrides.isPrivate ?? false,
      deletedAt: null,
    },
  };
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
      msgFindUnique: vi.fn().mockResolvedValue({
        id: ROOT,
        parentMessageId: null,
        deletedAt: new Date(),
        channel: {
          id: 'channel-1',
          workspaceId: 'ws-1',
          isPrivate: false,
          deletedAt: null,
        },
      }),
    });
    await expect(svc.subscribe({ userId: ME, threadParentId: ROOT })).rejects.toThrow(
      /thread root not found/,
    );
  });

  it('reply 에 subscribe 시 VALIDATION_FAILED', async () => {
    const svc = makeSvc({
      msgFindUnique: vi.fn().mockResolvedValue({
        id: REPLY,
        parentMessageId: ROOT,
        deletedAt: null,
        channel: {
          id: 'channel-1',
          workspaceId: 'ws-1',
          isPrivate: false,
          deletedAt: null,
        },
      }),
    });
    await expect(svc.subscribe({ userId: ME, threadParentId: REPLY })).rejects.toThrow(
      /cannot subscribe to a reply/,
    );
  });

  it('이미 follow 중이면 idempotent (subscribed: true 그대로)', async () => {
    const subCreate = vi.fn();
    const svc = makeSvc({
      msgFindUnique: vi.fn().mockResolvedValue(rootMsg()),
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
      msgFindUnique: vi.fn().mockResolvedValue(rootMsg()),
      subFindUnique: vi.fn().mockResolvedValue(null),
      subCreate,
    });
    const r = await svc.subscribe({ userId: ME, threadParentId: ROOT });
    expect(r.subscribed).toBe(true);
    expect(subCreate).toHaveBeenCalledOnce();
  });

  /**
   * task-047 iter0 (HIGH-046-A): channel ACL guard.
   * 임의의 사용자가 root UUID 만으로 subscribe → CHANNEL_NOT_FOUND.
   * 존재 leak 방지 위해 MESSAGE_NOT_FOUND 와 동일 응답.
   */
  it('caller 가 channel READ 권한 없으면 thread root not found (leak 방지)', async () => {
    const subCreate = vi.fn();
    const svc = makeSvc({
      msgFindUnique: vi.fn().mockResolvedValue(rootMsg({ isPrivate: true })),
      effective: 0, // READ 비트 없음
      subCreate,
    });
    await expect(svc.subscribe({ userId: ME, threadParentId: ROOT })).rejects.toThrow(
      /thread root not found/,
    );
    expect(subCreate).not.toHaveBeenCalled();
  });

  it('resolveEffective 가 throw (WORKSPACE_NOT_MEMBER) 해도 leak 안 함', async () => {
    const subCreate = vi.fn();
    const svc = makeSvc({
      msgFindUnique: vi.fn().mockResolvedValue(rootMsg()),
      effectiveThrows: true,
      subCreate,
    });
    await expect(svc.subscribe({ userId: ME, threadParentId: ROOT })).rejects.toThrow(
      /thread root not found/,
    );
    expect(subCreate).not.toHaveBeenCalled();
  });

  it('caller 가 READ 가지면 정상 subscribe (HIGH-046-A 정상 path)', async () => {
    const subCreate = vi.fn().mockResolvedValue({ createdAt: new Date('2025-01-01T00:00:00Z') });
    const svc = makeSvc({
      msgFindUnique: vi.fn().mockResolvedValue(rootMsg({ isPrivate: true })),
      effective: 0x0001, // READ only
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
