import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveMentionLabelMaps } from './mention-extractor';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S04 review HIGH (FR-MSG-13) — resolveMentionLabelMaps 단위 테스트.
 *
 * 정규화는 `@username` 을 `@{cuid2}` 로 저장하므로, 라이브 렌더가 회귀하지
 * 않으려면 저장 시점에 해석한 username/channel name 을 mention 노드 label 로
 * 박아야 합니다. 이 함수는 그 label 맵(id→표시명)을 만듭니다. 외부 모킹
 * 라이브러리 없이 vi.fn() 로 Prisma 의 findMany 만 스텁합니다.
 */
function stubPrisma(opts: {
  users?: { id: string; username: string }[];
  channels?: { id: string; name: string }[];
}): { prisma: PrismaClient; userArgs: unknown[]; channelArgs: unknown[] } {
  const userArgs: unknown[] = [];
  const channelArgs: unknown[] = [];
  const userFindMany = vi.fn(async (args: unknown) => {
    userArgs.push(args);
    return opts.users ?? [];
  });
  const channelFindMany = vi.fn(async (args: unknown) => {
    channelArgs.push(args);
    return opts.channels ?? [];
  });
  const prisma = {
    user: { findMany: userFindMany },
    channel: { findMany: channelFindMany },
  } as unknown as PrismaClient;
  return { prisma, userArgs, channelArgs };
}

describe('resolveMentionLabelMaps (S04 review HIGH / FR-MSG-13)', () => {
  it('maps userId → username (original casing preserved for display)', async () => {
    const { prisma } = stubPrisma({
      users: [{ id: 'clh3z2k0v0000aaaaaaaaaaaa', username: 'Alice' }],
    });
    const { users } = await resolveMentionLabelMaps(prisma, 'ws1', 'hi @Alice');
    expect(users.get('clh3z2k0v0000aaaaaaaaaaaa')).toBe('Alice');
  });

  it('maps channelId → channel name', async () => {
    const { prisma } = stubPrisma({
      channels: [{ id: 'clh3z2k0v0000chan1234ab', name: 'general' }],
    });
    const { channels } = await resolveMentionLabelMaps(prisma, 'ws1', 'see #general');
    expect(channels.get('clh3z2k0v0000chan1234ab')).toBe('general');
  });

  it('returns empty maps for a global DM (workspaceId=null) — mentions have no namespace', async () => {
    const { prisma, userArgs, channelArgs } = stubPrisma({});
    const { users, channels } = await resolveMentionLabelMaps(prisma, null, 'hi @alice #general');
    expect(users.size).toBe(0);
    expect(channels.size).toBe(0);
    // and it must not even touch the DB for a DM.
    expect(userArgs).toHaveLength(0);
    expect(channelArgs).toHaveLength(0);
  });

  it('skips @everyone / @here / @channel special mentions in the user query', async () => {
    const { prisma, userArgs } = stubPrisma({ users: [] });
    await resolveMentionLabelMaps(prisma, 'ws1', '@everyone @here @channel @alice');
    const where = (userArgs[0] as { where: { username: { in: string[] } } }).where;
    expect(where.username.in).toEqual(['alice']);
  });

  it('does not query when there are no resolvable handles', async () => {
    const { prisma, userArgs, channelArgs } = stubPrisma({});
    const { users, channels } = await resolveMentionLabelMaps(prisma, 'ws1', 'plain text');
    expect(users.size).toBe(0);
    expect(channels.size).toBe(0);
    expect(userArgs).toHaveLength(0);
    expect(channelArgs).toHaveLength(0);
  });

  it('scopes the user lookup to workspace members (mentions cannot escape the workspace)', async () => {
    const { prisma, userArgs } = stubPrisma({ users: [] });
    await resolveMentionLabelMaps(prisma, 'ws1', 'hi @alice');
    const where = (userArgs[0] as { where: { memberships: { some: { workspaceId: string } } } })
      .where;
    expect(where.memberships.some.workspaceId).toBe('ws1');
  });
});
