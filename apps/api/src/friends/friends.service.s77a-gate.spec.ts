import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FriendsService } from './friends.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import type { PrismaService } from '../prisma/prisma.module';
import type { OutboxService } from '../common/outbox/outbox.service';

/**
 * S77a (D14 / FR-PS-13): 친구 요청 수신 정책 게이트(requestByUsername)의 순수 도메인
 * 단위 테스트. 외부(Prisma / Outbox)는 vi.fn() 으로만 모킹. 시간 고정(2025-01-01).
 *
 * 게이트 매트릭스(대상의 allowFriendRequests):
 *   EVERYONE          → 신규 PENDING 생성 허용.
 *   NOBODY            → 403 FRIEND_REQUEST_BLOCKED.
 *   MUTUAL_WORKSPACE  → 공통 워크스페이스 있으면 허용, 없으면 403.
 *   행 부재(null)      → 기본 EVERYONE(허용).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = 'me-id';
const TARGET = 'target-id';

function makeService(opts: {
  policy: 'EVERYONE' | 'MUTUAL_WORKSPACE' | 'NOBODY' | null;
  sharedWorkspace: boolean;
}): {
  service: FriendsService;
  createCalls: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({
    id: 'fr1',
    requesterId: ME,
    addresseeId: TARGET,
    status: 'PENDING',
  });
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: TARGET, username: 'target' }),
    },
    friendship: {
      // findRow(meId, target) — no existing row so we reach the gate + create path.
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create,
    },
    userSettings: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.policy === null ? null : { allowFriendRequests: opts.policy }),
    },
    workspaceMember: {
      findFirst: vi.fn().mockResolvedValue(opts.sharedWorkspace ? { workspaceId: 'ws1' } : null),
    },
    // Serializable 트랜잭션 — 콜백을 tx=prisma 로 그대로 실행한다.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ friendship: { count: vi.fn().mockResolvedValue(0), create } }),
    ),
  } as unknown as PrismaService;

  const outbox = { record: vi.fn().mockResolvedValue(undefined) } as unknown as OutboxService;
  return { service: new FriendsService(prisma, outbox), createCalls: create };
}

describe('S77a friend-request policy gate', () => {
  it('EVERYONE allows a new request', async () => {
    const { service, createCalls } = makeService({ policy: 'EVERYONE', sharedWorkspace: false });
    await service.requestByUsername(ME, 'target');
    expect(createCalls).toHaveBeenCalledTimes(1);
  });

  it('missing settings row defaults to EVERYONE (allow)', async () => {
    const { service, createCalls } = makeService({ policy: null, sharedWorkspace: false });
    await service.requestByUsername(ME, 'target');
    expect(createCalls).toHaveBeenCalledTimes(1);
  });

  it('NOBODY rejects with FRIEND_REQUEST_BLOCKED (403)', async () => {
    const { service, createCalls } = makeService({ policy: 'NOBODY', sharedWorkspace: true });
    await expect(service.requestByUsername(ME, 'target')).rejects.toMatchObject({
      code: ErrorCode.FRIEND_REQUEST_BLOCKED,
    });
    expect(createCalls).not.toHaveBeenCalled();
  });

  it('MUTUAL_WORKSPACE allows when a workspace is shared', async () => {
    const { service, createCalls } = makeService({
      policy: 'MUTUAL_WORKSPACE',
      sharedWorkspace: true,
    });
    await service.requestByUsername(ME, 'target');
    expect(createCalls).toHaveBeenCalledTimes(1);
  });

  it('MUTUAL_WORKSPACE rejects when no workspace is shared', async () => {
    const { service, createCalls } = makeService({
      policy: 'MUTUAL_WORKSPACE',
      sharedWorkspace: false,
    });
    await expect(service.requestByUsername(ME, 'target')).rejects.toBeInstanceOf(DomainError);
    expect(createCalls).not.toHaveBeenCalled();
  });
});
