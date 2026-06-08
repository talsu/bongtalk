import { describe, expect, it } from 'vitest';
import {
  HoistGroupSchema,
  LARGE_WORKSPACE_THRESHOLD,
  ListMembersResponseSchema,
  MEMBER_LIST_PAGE_SIZE,
  MemberWithPresenceSchema,
} from './workspace';
import { SYSTEM_ROLE_HOIST_DEFAULT } from './roles';

/**
 * S27 / FR-P09 (task-068 · S95): grouped member-list contract.
 *
 * FR-P09: hoist 는 역할기반(Role.hoistInMemberList)으로 전환됐다. 종전 HOISTED_ROLES/
 * isHoistedRole(OWNER/ADMIN enum 하드코딩)은 제거됐고, HoistGroup.key 는 roleId(z.string)
 * 다. 시스템 역할 기본 hoist 값은 SYSTEM_ROLE_HOIST_DEFAULT(OWNER/ADMIN true)가 출처다.
 */
describe('member list contract', () => {
  it('hoists OWNER + ADMIN system roles by default, not the rest (FR-P09)', () => {
    expect(SYSTEM_ROLE_HOIST_DEFAULT.OWNER).toBe(true);
    expect(SYSTEM_ROLE_HOIST_DEFAULT.ADMIN).toBe(true);
    expect(SYSTEM_ROLE_HOIST_DEFAULT.MODERATOR).toBe(false);
    expect(SYSTEM_ROLE_HOIST_DEFAULT.MEMBER).toBe(false);
    expect(SYSTEM_ROLE_HOIST_DEFAULT.GUEST).toBe(false);
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

  it('FR-P09: a hoist group keys on roleId and carries an optional role color', () => {
    const roleId = '33333333-3333-4333-8333-333333333333';
    const parsed = HoistGroupSchema.parse({
      key: roleId,
      label: '운영진',
      color: '#5865f2',
      members: [],
    });
    expect(parsed.key).toBe(roleId);
    expect(parsed.color).toBe('#5865f2');

    // color 는 optional — 색 없는 역할은 생략/null 도 유효하다.
    const noColor = HoistGroupSchema.parse({ key: roleId, label: 'Mods', members: [] });
    expect(noColor.color).toBeUndefined();
    const nullColor = HoistGroupSchema.parse({
      key: roleId,
      label: 'Mods',
      color: null,
      members: [],
    });
    expect(nullColor.color).toBeNull();
  });

  it('a full response parses with per-role hoist + status groups + cursor (FR-P08/P09/P12)', () => {
    const ownerRoleId = '44444444-4444-4444-4444-444444444444';
    const adminRoleId = '55555555-5555-5555-5555-555555555555';
    const parsed = ListMembersResponseSchema.parse({
      hoist: [
        { key: ownerRoleId, label: 'OWNER', members: [] },
        { key: adminRoleId, label: 'ADMIN', members: [] },
      ],
      groups: [
        { key: 'online', label: '온라인', members: [] },
        { key: 'offline', label: '오프라인', members: [] },
      ],
      nextCursor: null,
      includeOffline: true,
    });
    expect(parsed.hoist.map((g) => g.key)).toEqual([ownerRoleId, adminRoleId]);
    expect(parsed.groups.map((g) => g.key)).toEqual(['online', 'offline']);
    expect(parsed.includeOffline).toBe(true);
  });
});
