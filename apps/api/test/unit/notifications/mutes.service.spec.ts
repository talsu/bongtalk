import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MutesService } from '../../../src/notifications/mutes/mutes.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const CHAN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeService(prismaStub: {
  upsert?: ReturnType<typeof vi.fn>;
  deleteMany?: ReturnType<typeof vi.fn>;
  findMany?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  const prisma = {
    userChannelMute: {
      upsert: prismaStub.upsert ?? vi.fn(),
      deleteMany: prismaStub.deleteMany ?? vi.fn(),
      findMany: prismaStub.findMany ?? vi.fn().mockResolvedValue([]),
      findUnique: prismaStub.findUnique ?? vi.fn().mockResolvedValue(null),
      update: prismaStub.update ?? vi.fn(),
    },
  } as unknown as ConstructorParameters<typeof MutesService>[0];
  return new MutesService(prisma);
}

describe('MutesService.setMute', () => {
  it('upsert 호출 — 신규 mute (S46: isMuted=true 명시 set)', async () => {
    const upsert = vi.fn().mockResolvedValue({
      channelId: CHAN_A,
      mutedUntil: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const svc = makeService({ upsert });
    const result = await svc.setMute({ userId: USER_A, channelId: CHAN_A, mutedUntil: null });
    expect(upsert).toHaveBeenCalledOnce();
    expect(result.channelId).toBe(CHAN_A);
    expect(result.mutedUntil).toBeNull();
    // S46 fix-forward (BLOCKER 3): create/update 모두 isMuted=true 를 set.
    const args = upsert.mock.calls[0][0];
    expect(args.create.isMuted).toBe(true);
    expect(args.update.isMuted).toBe(true);
  });

  it('mutedUntil 시각 갱신', async () => {
    const until = new Date('2025-01-02T00:00:00Z');
    const upsert = vi.fn().mockResolvedValue({
      channelId: CHAN_A,
      mutedUntil: until,
      createdAt: new Date(),
    });
    const svc = makeService({ upsert });
    const result = await svc.setMute({ userId: USER_A, channelId: CHAN_A, mutedUntil: until });
    expect(result.mutedUntil).toEqual(until);
  });
});

describe('MutesService.removeMute', () => {
  it('미존재면 idempotent — 아무 쓰기도 안 함', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const update = vi.fn();
    const svc = makeService({ findUnique, deleteMany, update });
    await svc.removeMute({ userId: USER_A, channelId: CHAN_A });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('level 상속(null) 행 → 삭제', async () => {
    const findUnique = vi.fn().mockResolvedValue({ level: null });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn();
    const svc = makeService({ findUnique, deleteMany, update });
    await svc.removeMute({ userId: USER_A, channelId: CHAN_A });
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('S46 fix-forward (HIGH): level 오버라이드 보존 → isMuted=false·mutedUntil=null update', async () => {
    const findUnique = vi.fn().mockResolvedValue({ level: 'NOTHING' });
    const deleteMany = vi.fn();
    const update = vi.fn().mockResolvedValue({});
    const svc = makeService({ findUnique, deleteMany, update });
    await svc.removeMute({ userId: USER_A, channelId: CHAN_A });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { userId_channelId: { userId: USER_A, channelId: CHAN_A } },
      data: { isMuted: false, mutedUntil: null },
    });
  });
});

describe('MutesService.listActiveMutes', () => {
  it('만료/비뮤트 제외 query 호출 (S46: isMuted=true 필터)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { channelId: CHAN_A, mutedUntil: null, createdAt: new Date('2025-01-01T00:00:00Z') },
      {
        channelId: CHAN_B,
        mutedUntil: new Date('2025-01-02T00:00:00Z'),
        createdAt: new Date('2024-12-30T00:00:00Z'),
      },
    ]);
    const svc = makeService({ findMany });
    const items = await svc.listActiveMutes(USER_A);
    expect(items).toHaveLength(2);
    expect(findMany).toHaveBeenCalledOnce();
    const where = findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(USER_A);
    expect(where.isMuted).toBe(true);
    expect(where.OR).toBeDefined();
  });
});

describe('MutesService.filterMutedRecipients', () => {
  it('빈 candidates → 빈 리턴', async () => {
    const findMany = vi.fn();
    const svc = makeService({ findMany });
    const out = await svc.filterMutedRecipients(CHAN_A, []);
    expect(out).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('muted user 만 제외', async () => {
    const findMany = vi.fn().mockResolvedValue([{ userId: USER_A }]);
    const svc = makeService({ findMany });
    const out = await svc.filterMutedRecipients(CHAN_A, [USER_A, USER_B]);
    expect(out).toEqual([USER_B]);
  });

  it('아무도 muted 안 했으면 그대로', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const svc = makeService({ findMany });
    const out = await svc.filterMutedRecipients(CHAN_A, [USER_A, USER_B]);
    expect(out).toEqual([USER_A, USER_B]);
  });

  it('만료/비뮤트 제외 — query 의 isMuted=true + OR 가 처리 (S46)', async () => {
    // findMany 가 만료 안 된 행만 반환 — service 는 그대로 사용.
    const findMany = vi.fn().mockResolvedValue([{ userId: USER_A }]);
    const svc = makeService({ findMany });
    await svc.filterMutedRecipients(CHAN_A, [USER_A]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.isMuted).toBe(true);
    expect(where.OR).toBeDefined();
    expect(where.OR).toEqual([{ mutedUntil: null }, { mutedUntil: { gt: expect.any(Date) } }]);
  });
});
