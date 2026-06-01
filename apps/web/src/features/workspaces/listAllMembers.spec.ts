import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListMembersResponse, Member } from '@qufox/shared-types';

/**
 * S27 fix-forward(regression · @멘션): listAllMembers must walk EVERY cursor
 * page so the 51st+ member is mentionable and offline members on a large
 * workspace are never dropped. The previous useMembers flattened only the
 * grouped first page (50-row cap + offline drop), so a workspace with > 50
 * members could not @-mention anyone past the first page.
 */

// Mock the low-level request helper; listAllMembers is the unit under test.
const apiRequest = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

function member(i: number): Member {
  const uid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  return {
    userId: uid,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    role: 'MEMBER',
    joinedAt: '2025-01-01T00:00:00.000Z',
    user: { id: uid, username: `u${i}`, email: `u${i}@qufox.dev` },
  };
}

function page(members: Member[], nextCursor: string | null): ListMembersResponse {
  return {
    hoist: [],
    groups: [
      {
        key: 'online',
        label: '온라인',
        members: members.map((m) => ({ ...m, status: 'online', lastSeenAt: null })),
      },
    ],
    nextCursor,
    includeOffline: true,
  };
}

describe('listAllMembers (S27 fix-forward — @멘션 completeness)', () => {
  afterEach(() => {
    apiRequest.mockReset();
  });

  it('walks every cursor page and returns ALL members (51st findable)', async () => {
    const { listAllMembers } = await import('./api');

    const firstPage = Array.from({ length: 50 }, (_, i) => member(i + 1));
    const secondPage = [member(51)];
    apiRequest
      .mockResolvedValueOnce(page(firstPage, 'cursor-page-2'))
      .mockResolvedValueOnce(page(secondPage, null));

    const { members } = await listAllMembers('11111111-1111-4111-8111-111111111111');

    expect(members).toHaveLength(51);
    // The 51st member (only on page 2) is present — @-mention can resolve it.
    const m51 = members.find((m) => m.user.username === 'u51');
    expect(m51).toBeDefined();
    // include_offline=true is always requested so offline members aren't dropped.
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(String(apiRequest.mock.calls[0][0])).toContain('include_offline=true');
  });

  it('stops on the first page when there is no nextCursor', async () => {
    const { listAllMembers } = await import('./api');
    apiRequest.mockResolvedValueOnce(page([member(1)], null));

    const { members } = await listAllMembers('11111111-1111-4111-8111-111111111111');
    expect(members).toHaveLength(1);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});
