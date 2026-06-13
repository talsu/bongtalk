import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelsService } from './channels.service';

/**
 * 072 백로그 S-D (FR-CH-06): listBrowsable — 공개 채널 둘러보기 목록의 memberCount(가입
 * opt-in USER override 행 수) + isMember(호출자 행 존재) 매핑을 검증한다. Prisma 스텁만
 * 사용(vi.fn). 시스템 시간 고정(harness 규약).
 */
vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

type PrismaWhere = Record<string, unknown>;

function channelRow(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    workspaceId: 'ws1',
    categoryId: null,
    name: 'general',
    type: 'TEXT',
    topic: null,
    description: null,
    position: 1000,
    slowmodeSeconds: 0,
    memberCanPin: true,
    fileUploadEnabled: true,
    maxFileSizeBytes: null,
    isPrivate: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...over,
  };
}

function makeService(opts: {
  channels: ReturnType<typeof channelRow>[];
  groupBy?: Array<{ channelId: string; _count: { _all: number } }>;
  mine?: Array<{ channelId: string }>;
}) {
  const captured: {
    channelWhere?: PrismaWhere;
    groupByWhere?: PrismaWhere;
    mineWhere?: PrismaWhere;
  } = {};
  const findMany = vi.fn(async (a: { where: PrismaWhere; orderBy?: unknown }) => {
    captured.channelWhere = a.where;
    return opts.channels;
  });
  const groupBy = vi.fn(async (a: { where: PrismaWhere; by: unknown; _count: unknown }) => {
    captured.groupByWhere = a.where;
    return opts.groupBy ?? [];
  });
  const cpoFindMany = vi.fn(async (a: { where: PrismaWhere; select: unknown }) => {
    captured.mineWhere = a.where;
    return opts.mine ?? [];
  });
  const prisma = {
    channel: { findMany },
    channelPermissionOverride: { groupBy, findMany: cpoFindMany },
  };
  const svc = new ChannelsService(
    prisma as never,
    {} as never, // outbox
    {} as never, // messages
    {} as never, // audit
    undefined as never, // redis (optional)
  );
  return { svc, findMany, groupBy, cpoFindMany, captured };
}

describe('ChannelsService.listBrowsable (072 S-D / FR-CH-06)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('공개·비보관·비삭제·비DIRECT 채널만 질의한다', async () => {
    const { svc, findMany, captured } = makeService({ channels: [] });
    await svc.listBrowsable('ws1', 'u1');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(captured.channelWhere).toMatchObject({
      workspaceId: 'ws1',
      deletedAt: null,
      archivedAt: null,
      isPrivate: false,
      type: { not: 'DIRECT' },
    });
  });

  it('채널이 없으면 빈 배열을 즉시 반환(집계 쿼리 미실행)', async () => {
    const { svc, groupBy, cpoFindMany } = makeService({ channels: [] });
    const r = await svc.listBrowsable('ws1', 'u1');
    expect(r).toEqual({ channels: [] });
    expect(groupBy).not.toHaveBeenCalled();
    expect(cpoFindMany).not.toHaveBeenCalled();
  });

  it('memberCount 는 groupBy _count 로 매핑되고 행 없는 채널은 0', async () => {
    const { svc } = makeService({
      channels: [channelRow({ id: 'c1', name: 'a' }), channelRow({ id: 'c2', name: 'b' })],
      groupBy: [{ channelId: 'c1', _count: { _all: 3 } }],
      mine: [],
    });
    const r = await svc.listBrowsable('ws1', 'u1');
    const byId = new Map(r.channels.map((c) => [c.id, c]));
    expect(byId.get('c1')?.memberCount).toBe(3);
    expect(byId.get('c2')?.memberCount).toBe(0);
  });

  it('isMember 는 호출자 USER override 행이 있는 채널만 true', async () => {
    const { svc, captured } = makeService({
      channels: [channelRow({ id: 'c1', name: 'a' }), channelRow({ id: 'c2', name: 'b' })],
      groupBy: [],
      mine: [{ channelId: 'c2' }],
    });
    const r = await svc.listBrowsable('ws1', 'u1');
    const byId = new Map(r.channels.map((c) => [c.id, c]));
    expect(byId.get('c1')?.isMember).toBe(false);
    expect(byId.get('c2')?.isMember).toBe(true);
    // 호출자 행 조회는 USER + principalId + leftAt null 로 스코프된다.
    expect(captured.mineWhere).toMatchObject({
      principalType: 'USER',
      principalId: 'u1',
      leftAt: null,
    });
  });

  it('memberCount/isMember 집계는 USER + leftAt null + 순수 deny 제한행 제외로 스코프된다', async () => {
    const { svc, captured } = makeService({
      channels: [channelRow()],
      groupBy: [{ channelId: 'c1', _count: { _all: 1 } }],
    });
    await svc.listBrowsable('ws1', 'u1');
    // 072 S-D 리뷰(MEDIUM): join 마커(deny=0)·grant(allow>0)는 포함하고, 순수 deny 제한
    // (allow=0 AND deny>0)은 NOT 절로 제외한다 — admin 제한 override 의 멤버 오집계 방지.
    expect(captured.groupByWhere).toMatchObject({
      principalType: 'USER',
      leftAt: null,
      NOT: { allowMask: 0, denyMask: { gt: 0 } },
    });
    // 호출자 isMember 조회도 동일 멤버십 스코프를 쓴다.
    expect(captured.mineWhere).toMatchObject({
      principalType: 'USER',
      principalId: 'u1',
      leftAt: null,
      NOT: { allowMask: 0, denyMask: { gt: 0 } },
    });
  });
});
