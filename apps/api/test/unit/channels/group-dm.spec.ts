import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectMessagesService } from '../../../src/channels/direct-messages/direct-messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';

// S16 (FR-DM-16): DirectMessagesService 가 outbox 에 dm.created 를 기록하므로
// 단위 테스트는 record() 를 캡처하는 fake outbox 를 주입한다(외부 모킹 라이브러리
// 금지 — vi.fn() 만).
function fakeOutbox(): OutboxService {
  return { record: vi.fn().mockResolvedValue('outbox-id') } as unknown as OutboxService;
}

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
  // S16 (BLOCKER fix-forward): 전역 그룹 경로가 멤버별 친구 게이트(assertCanDm →
  // friendship.findFirst)를 호출하므로 기본 ACCEPTED 를 돌려주는 stub 을 둔다.
  friendshipFindFirst?: ReturnType<typeof vi.fn>;
  // S19 (FR-DM-12): 전역 그룹 경로가 멤버별 DM 수신권한 게이트(assertDmPrivacyAllows
  // → user.findUnique)도 호출하므로 기본 EVERYONE 을 돌려주는 stub 을 둔다.
  userFindUnique?: ReturnType<typeof vi.fn>;
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
  const friendship = {
    findFirst: stub.friendshipFindFirst ?? vi.fn().mockResolvedValue({ status: 'ACCEPTED' }),
  };
  // S19 (FR-DM-12): assertDmPrivacyAllows 가 user.findUnique 로 allowDmFrom 을
  // 조회한다. 기본 EVERYONE 으로 게이트를 통과시켜 기존 친구 게이트 단위 검증을
  // 보존한다(privacy 게이트는 int 에서 별도 검증).
  const user = {
    findUnique: stub.userFindUnique ?? vi.fn().mockResolvedValue({ allowDmFrom: 'EVERYONE' }),
  };
  const tx: TxStub = { channel, channelPermissionOverride };
  const prisma = {
    channel,
    workspaceMember,
    friendship,
    user,
    $transaction: stub.transaction ?? vi.fn(async (cb: (tx: TxStub) => Promise<unknown>) => cb(tx)),
  } as unknown as ConstructorParameters<typeof DirectMessagesService>[0];
  return new DirectMessagesService(prisma, fakeOutbox());
}

describe('DirectMessagesService.createGroupDm', () => {
  it('memberIds 길이 < 2 → VALIDATION_FAILED', async () => {
    const svc = makeService({});
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [A] }),
    ).rejects.toThrow(DomainError);
  });

  it('FR-DM-02: memberIds 길이 > 19 (총 21명) → DM_GROUP_CAP_EXCEEDED', async () => {
    const svc = makeService({});
    const tooMany = Array.from(
      { length: 20 },
      (_, i) => `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: tooMany }),
    ).rejects.toMatchObject({ code: ErrorCode.DM_GROUP_CAP_EXCEEDED });
  });

  it('FR-DM-02: 본인 외 19명(총 20, cap 경계) 은 통과 → 신규 채널 생성', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const channelCreate = vi.fn().mockResolvedValue({ id: 'ch-cap' });
    const overrideCreate = vi.fn();
    const svc = makeService({ findFirst, channelCreate, overrideCreate });
    const others = Array.from(
      { length: 19 },
      (_, i) => `${i.toString().padStart(8, '0')}-2222-4222-8222-222222222222`,
    );
    const result = await svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: others });
    expect(result.created).toBe(true);
    // 본인 + 19 = 20 override 행
    expect(overrideCreate).toHaveBeenCalledTimes(20);
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

  it('BLOCKER fix-forward: global scope 에서 비친구 memberId 있으면 FRIEND_NOT_FOUND', async () => {
    // 첫 멤버(A)는 ACCEPTED, 두 번째 멤버(B)는 친구 아님(null) → 거부.
    const friendshipFindFirst = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ACCEPTED' })
      .mockResolvedValueOnce(null);
    const channelCreate = vi.fn();
    const svc = makeService({ friendshipFindFirst, channelCreate });
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [A, B] }),
    ).rejects.toMatchObject({ code: ErrorCode.FRIEND_NOT_FOUND });
    // 채널 생성까지 가지 않는다(게이트가 먼저 끊음).
    expect(channelCreate).not.toHaveBeenCalled();
  });

  it('BLOCKER fix-forward: BLOCKED 친구도 동일하게 거부(중립) — global scope', async () => {
    const friendshipFindFirst = vi.fn().mockResolvedValue({ status: 'BLOCKED' });
    const svc = makeService({ friendshipFindFirst });
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [A] }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED }); // length<2
    // 길이 2 이상으로 다시 — BLOCKED → FRIEND_NOT_FOUND.
    await expect(
      svc.createGroupDm({ workspaceId: null, meId: ME, memberIds: [A, B] }),
    ).rejects.toMatchObject({ code: ErrorCode.FRIEND_NOT_FOUND });
  });

  it('workspace scope 는 친구 게이트를 거치지 않는다(멤버십 게이트만)', async () => {
    // workspace 멤버 전원 충족 → friendship.findFirst 가 호출되지 않아야 한다.
    const workspaceMemberFindMany = vi
      .fn()
      .mockResolvedValue([{ userId: ME }, { userId: A }, { userId: B }]);
    const friendshipFindFirst = vi.fn();
    const channelCreate = vi.fn().mockResolvedValue({ id: 'ch-ws' });
    const overrideCreate = vi.fn();
    const svc = makeService({
      workspaceMemberFindMany,
      friendshipFindFirst,
      channelCreate,
      overrideCreate,
    });
    const result = await svc.createGroupDm({ workspaceId: 'ws-1', meId: ME, memberIds: [A, B] });
    expect(result.created).toBe(true);
    expect(friendshipFindFirst).not.toHaveBeenCalled();
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
    return new DirectMessagesService(prisma, fakeOutbox());
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
