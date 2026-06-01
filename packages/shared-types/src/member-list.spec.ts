import { describe, expect, it } from 'vitest';
import {
  HOISTED_ROLES,
  LARGE_WORKSPACE_THRESHOLD,
  ListMembersResponseSchema,
  MEMBER_LIST_PAGE_SIZE,
  MemberWithPresenceSchema,
  isHoistedRole,
} from './workspace';

/**
 * S27 (FR-P08/P09/P11/P12): grouped member-list contract.
 */
describe('S27 member list contract', () => {
  it('hoists OWNER + ADMIN, not MEMBER (FR-P09)', () => {
    expect(isHoistedRole('OWNER')).toBe(true);
    expect(isHoistedRole('ADMIN')).toBe(true);
    expect(isHoistedRole('MEMBER')).toBe(false);
    expect(HOISTED_ROLES.has('MEMBER')).toBe(false);
  });

  it('page size is 50, large threshold is 1000 (FR-P11/P12)', () => {
    expect(MEMBER_LIST_PAGE_SIZE).toBe(50);
    expect(LARGE_WORKSPACE_THRESHOLD).toBe(1000);
  });

  it('a member row carries masked status + nullable lastSeenAt (FR-P08/P10)', () => {
    const online = MemberWithPresenceSchema.parse({
      userId: '11111111-1111-1111-1111-111111111111',
      workspaceId: '22222222-2222-2222-2222-222222222222',
      role: 'MEMBER',
      joinedAt: '2025-01-01T00:00:00.000Z',
      user: { id: '11111111-1111-1111-1111-111111111111', username: 'a', email: 'a@qufox.dev' },
      status: 'online',
      lastSeenAt: null,
    });
    expect(online.status).toBe('online');
    expect(online.lastSeenAt).toBeNull();

    const offline = MemberWithPresenceSchema.parse({
      userId: '11111111-1111-1111-1111-111111111111',
      workspaceId: '22222222-2222-2222-2222-222222222222',
      role: 'MEMBER',
      joinedAt: '2025-01-01T00:00:00.000Z',
      user: { id: '11111111-1111-1111-1111-111111111111', username: 'a', email: 'a@qufox.dev' },
      status: 'offline',
      lastSeenAt: '2025-01-01T00:00:00.000Z',
    });
    expect(offline.lastSeenAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('a full response parses with hoist + status groups + cursor (FR-P08/P12)', () => {
    const parsed = ListMembersResponseSchema.parse({
      hoist: [
        {
          key: 'staff',
          label: '운영진',
          members: [],
        },
      ],
      groups: [
        { key: 'online', label: '온라인', members: [] },
        { key: 'offline', label: '오프라인', members: [] },
      ],
      nextCursor: null,
      includeOffline: true,
    });
    expect(parsed.hoist[0].key).toBe('staff');
    expect(parsed.groups.map((g) => g.key)).toEqual(['online', 'offline']);
    expect(parsed.includeOffline).toBe(true);
  });
});
