import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectMessagesService } from '../../../src/channels/direct-messages/direct-messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';

type Stub = {
  findFirst?: ReturnType<typeof vi.fn>;
  workspaceMemberFindMany?: ReturnType<typeof vi.fn>;
  channelCreate?: ReturnType<typeof vi.fn>;
  overrideCreate?: ReturnType<typeof vi.fn>;
  transaction?: ReturnType<typeof vi.fn>;
};

type TxStub = {
  channel: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  channelPermissionOverride: { create: ReturnType<typeof vi.fn> };
};

function makeService(stub: Stub) {
  const channel = {
    findFirst: stub.findFirst ?? vi.fn().mockResolvedValue(null),
    create: stub.channelCreate ?? vi.fn(),
  };
  const channelPermissionOverride = { create: stub.overrideCreate ?? vi.fn() };
  const workspaceMember = {
    findMany: stub.workspaceMemberFindMany ?? vi.fn().mockResolvedValue([]),
  };
  const tx: TxStub = { channel, channelPermissionOverride };
  const prisma = {
    channel,
    workspaceMember,
    $transaction: stub.transaction ?? vi.fn(async (cb: (tx: TxStub) => Promise<unknown>) => cb(tx)),
  } as unknown as ConstructorParameters<typeof DirectMessagesService>[0];
  return new DirectMessagesService(prisma);
}

describe('DirectMessagesService.createGroupDm', () => {
  it('memberIds 길이 < 2 → VALIDATION_FAILED', async () => {
    const svc = makeService({});
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [A] }),
    ).rejects.toThrow(DomainError);
  });

  it('memberIds 길이 > 9 (총 11명) → VALIDATION_FAILED', async () => {
    const svc = makeService({});
    const tooMany = Array.from(
      { length: 10 },
      (_, i) => `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: tooMany }),
    ).rejects.toThrow(/cap exceeded/);
  });

  it('memberIds 에 본인 포함 시 VALIDATION_FAILED', async () => {
    const svc = makeService({});
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [ME, A] }),
    ).rejects.toThrow(/yourself/);
  });

  it('memberIds 중복 시 VALIDATION_FAILED', async () => {
    const svc = makeService({});
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [A, A] }),
    ).rejects.toThrow(/unique/);
  });

  it('global scope (workspaceId=null) + 같은 멤버 set 이미 있으면 created=false', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'ch-existing' });
    const channelCreate = vi.fn();
    const svc = makeService({ findFirst, channelCreate });
    const result = await svc.createGroupDm({
      workspaceId: null,
      meId: ME,
      memberIds: [A, B],
    });
    expect(result.created).toBe(false);
    expect(result.channelId).toBe('ch-existing');
    expect(channelCreate).not.toHaveBeenCalled();
  });

  it('global scope 신규 → channel + N+1 override 행 생성', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const channelCreate = vi.fn().mockResolvedValue({ id: 'ch-new' });
    const overrideCreate = vi.fn();
    const svc = makeService({ findFirst, channelCreate, overrideCreate });
    const result = await svc.createGroupDm({
      workspaceId: null,
      meId: ME,
      memberIds: [A, B],
    });
    expect(result.created).toBe(true);
    expect(result.channelId).toBe('ch-new');
    expect(result.memberIds.sort()).toEqual([ME, A, B].sort());
    expect(channelCreate).toHaveBeenCalledOnce();
    // sender + 2 다른 멤버 = 3명 → 3 override 행
    expect(overrideCreate).toHaveBeenCalledTimes(3);
    const args = (channelCreate.mock.calls[0][0] as { data: { name: string } }).data;
    // gdm: 접두사 + 정렬된 ids
    expect(args.name.startsWith('gdm:')).toBe(true);
  });

  it('workspace scope: 멤버 중 워크스페이스 비멤버 있으면 WORKSPACE_NOT_MEMBER', async () => {
    const workspaceMemberFindMany = vi.fn().mockResolvedValue([
      { userId: ME },
      { userId: A },
      // B 누락 (워크스페이스 비멤버)
    ]);
    const svc = makeService({ workspaceMemberFindMany });
    await expect(
      svc.createGroupDm({ workspaceId: 'ws-1', meId: ME, memberIds: [A, B] }),
    ).rejects.toThrow(/all members must belong/);
  });

  it('동일 멤버 set 다른 순서 → 같은 slug → idempotent createOrGet', async () => {
    // 첫 호출 새 채널 생성, 두 번째 호출 같은 set 으로 → findFirst hit
    let lookupCount = 0;
    const findFirst = vi.fn().mockImplementation(async () => {
      lookupCount += 1;
      // 첫 호출은 null → create. 두 번째 호출은 hit 처럼 동작.
      return lookupCount === 1 ? null : { id: 'ch-existing' };
    });
    const channelCreate = vi.fn().mockResolvedValue({ id: 'ch-new' });
    const overrideCreate = vi.fn();
    const svc = makeService({ findFirst, channelCreate, overrideCreate });
    const r1 = await svc.createGroupDm({
      workspaceId: null,
      meId: ME,
      memberIds: [A, B, C],
    });
    expect(r1.created).toBe(true);
    const r2 = await svc.createGroupDm({
      workspaceId: null,
      meId: ME,
      // 다른 순서, 같은 set
      memberIds: [C, B, A],
    });
    expect(r2.created).toBe(false);
    expect(r2.channelId).toBe('ch-existing');
    // findFirst 가 같은 name 으로 두 번 호출 — slug 정렬 idempotent 검증
    const name1 = findFirst.mock.calls[0][0].where.name;
    const name2 = findFirst.mock.calls[1][0].where.name;
    expect(name1).toBe(name2);
  });
});

/**
 * task-046 iter0 (HIGH-2 carry-over): GDM 멤버 list endpoint.
 *
 * 권한: meId 가 GDM 멤버여야 200, 그 외 모두 404 (존재 leak 방지).
 * 본 spec 은 mock prisma 로 channel.findFirst / override.findFirst /
 * $queryRaw 를 자극.
 */
describe('DirectMessagesService.getGroupMembers', () => {
  const GDM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  function svcWith({
    channel,
    override,
    raw,
  }: {
    channel?: ReturnType<typeof vi.fn>;
    override?: ReturnType<typeof vi.fn>;
    raw?: ReturnType<typeof vi.fn>;
  }) {
    const channelFindFirst = channel ?? vi.fn().mockResolvedValue(null);
    const overrideFindFirst = override ?? vi.fn().mockResolvedValue(null);
    const queryRaw = raw ?? vi.fn().mockResolvedValue([]);
    const prisma = {
      channel: { findFirst: channelFindFirst, create: vi.fn() },
      channelPermissionOverride: { findFirst: overrideFindFirst, create: vi.fn() },
      workspaceMember: { findMany: vi.fn() },
      $transaction: vi.fn(),
      $queryRaw: queryRaw,
    } as unknown as ConstructorParameters<typeof DirectMessagesService>[0];
    return new DirectMessagesService(prisma);
  }

  it('채널 부재 → CHANNEL_NOT_FOUND', async () => {
    const svc = svcWith({ channel: vi.fn().mockResolvedValue(null) });
    await expect(svc.getGroupMembers(ME, GDM)).rejects.toThrow(/group DM not found/);
  });

  it('채널이 gdm: prefix 가 아니면 (1:1 DM) → CHANNEL_NOT_FOUND', async () => {
    const svc = svcWith({
      channel: vi.fn().mockResolvedValue({ id: GDM, name: 'dm:x:y' }),
    });
    await expect(svc.getGroupMembers(ME, GDM)).rejects.toThrow(/group DM not found/);
  });

  it('caller 가 GDM 멤버 아니면 (override 없음) → CHANNEL_NOT_FOUND', async () => {
    const svc = svcWith({
      channel: vi.fn().mockResolvedValue({ id: GDM, name: `gdm:${A}:${B}:${ME}` }),
      override: vi.fn().mockResolvedValue(null),
    });
    await expect(svc.getGroupMembers(ME, GDM)).rejects.toThrow(/group DM not found/);
  });

  it('caller override allowMask & READ = 0 (leave 후) → CHANNEL_NOT_FOUND', async () => {
    const svc = svcWith({
      channel: vi.fn().mockResolvedValue({ id: GDM, name: `gdm:${A}:${B}:${ME}` }),
      override: vi.fn().mockResolvedValue({ allowMask: 0 }),
    });
    await expect(svc.getGroupMembers(ME, GDM)).rejects.toThrow(/group DM not found/);
  });

  it('caller 가 GDM 멤버이면 모든 멤버 username + customStatus 반환', async () => {
    const rawRows = [
      { userId: A, username: 'alice', customStatus: '☕ working' },
      { userId: B, username: 'bob', customStatus: null },
      { userId: ME, username: 'me', customStatus: '🚀 OOO' },
    ];
    const svc = svcWith({
      channel: vi.fn().mockResolvedValue({ id: GDM, name: `gdm:${A}:${B}:${ME}` }),
      override: vi.fn().mockResolvedValue({ allowMask: 1 }),
      raw: vi.fn().mockResolvedValue(rawRows),
    });
    const res = await svc.getGroupMembers(ME, GDM);
    expect(res).toEqual([
      { userId: A, username: 'alice', customStatus: '☕ working' },
      { userId: B, username: 'bob', customStatus: null },
      { userId: ME, username: 'me', customStatus: '🚀 OOO' },
    ]);
  });

  it('soft-deleted 채널 (deletedAt!=null) → channel.findFirst 가 deletedAt:null where 로 null → CHANNEL_NOT_FOUND', async () => {
    // 서비스의 findFirst 호출 시 deletedAt=null 을 강제하는지 검증.
    const findFirst = vi.fn().mockResolvedValue(null);
    const svc = svcWith({ channel: findFirst });
    await expect(svc.getGroupMembers(ME, GDM)).rejects.toThrow(/group DM not found/);
    const callArg = findFirst.mock.calls[0][0];
    expect(callArg.where.deletedAt).toBe(null);
    expect(callArg.where.type).toBe('DIRECT');
  });
});
