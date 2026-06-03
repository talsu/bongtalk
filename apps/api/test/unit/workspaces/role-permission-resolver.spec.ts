import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PERMISSIONS, has } from '@qufox/shared-types';
import {
  resolveChannelPermissions,
  resolveWorkspacePermissions,
  type ResolverRole,
} from '../../../src/workspaces/roles/role-permission-resolver';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const everyone: ResolverRole = {
  id: 'everyone-id',
  permissions: PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_HISTORY,
  position: 0,
  isEveryone: true,
};

function role(id: string, permissions: bigint, position: number): ResolverRole {
  return { id, permissions, position, isEveryone: false };
}

// S61 (FR-RM03): ①@everyone 기본 → ②역할 OR → ③@everyone overwrite →
// ④역할 overwrite(position 오름차순) → ⑤멤버 overwrite. ADMINISTRATOR 는 ③~⑤ 무시.
describe('S61 channel permission 5-stage resolver', () => {
  it('① + ②: @everyone base OR member roles', () => {
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [role('r1', PERMISSIONS.SEND_MESSAGES, 100)],
    });
    expect(has(mask, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
    expect(has(mask, PERMISSIONS.READ_HISTORY)).toBe(true);
    expect(has(mask, PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(has(mask, PERMISSIONS.ATTACH_FILES)).toBe(false);
  });

  it('③ @everyone overwrite deny removes a base bit', () => {
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [],
      everyoneOverwrite: { allow: 0n, deny: PERMISSIONS.READ_HISTORY },
    });
    expect(has(mask, PERMISSIONS.READ_HISTORY)).toBe(false);
    expect(has(mask, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
  });

  it('④ higher-position role overwrite allow beats lower-position deny', () => {
    const low = role('low', 0n, 100);
    const high = role('high', 0n, 200);
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [high, low],
      roleOverwrites: new Map([
        ['low', { allow: 0n, deny: PERMISSIONS.SEND_MESSAGES }],
        ['high', { allow: PERMISSIONS.SEND_MESSAGES, deny: 0n }],
      ]),
    });
    // position 오름차순 적용: low(deny) 먼저 → high(allow) 나중 → allow 우선.
    expect(has(mask, PERMISSIONS.SEND_MESSAGES)).toBe(true);
  });

  it('⑤ member overwrite deny is the final word (beats role allow)', () => {
    const r = role('r', PERMISSIONS.SEND_MESSAGES, 100);
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [r],
      roleOverwrites: new Map([['r', { allow: PERMISSIONS.SEND_MESSAGES, deny: 0n }]]),
      memberOverwrite: { allow: 0n, deny: PERMISSIONS.SEND_MESSAGES },
    });
    expect(has(mask, PERMISSIONS.SEND_MESSAGES)).toBe(false);
  });

  it('⑤ member overwrite allow beats @everyone deny (③ < ⑤)', () => {
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [],
      everyoneOverwrite: { allow: 0n, deny: PERMISSIONS.VIEW_CHANNEL },
      memberOverwrite: { allow: PERMISSIONS.VIEW_CHANNEL, deny: 0n },
    });
    expect(has(mask, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
  });

  it('ADMINISTRATOR bypasses ③④⑤ overwrites entirely', () => {
    const admin = role('admin', PERMISSIONS.ADMINISTRATOR, 400);
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [admin],
      everyoneOverwrite: { allow: 0n, deny: PERMISSIONS.SEND_MESSAGES },
      roleOverwrites: new Map([['admin', { allow: 0n, deny: PERMISSIONS.SEND_MESSAGES }]]),
      memberOverwrite: { allow: 0n, deny: PERMISSIONS.SEND_MESSAGES },
    });
    // ADMINISTRATOR holder passes every check despite the DENY overwrites.
    expect(has(mask, PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(has(mask, PERMISSIONS.MANAGE_CHANNEL)).toBe(true);
  });
});

describe('S61 workspace permission resolver (overwrite-free base)', () => {
  it('ORs @everyone with member roles', () => {
    const mask = resolveWorkspacePermissions(everyone, [
      role('r1', PERMISSIONS.MANAGE_CHANNEL, 100),
      role('r2', PERMISSIONS.CREATE_INVITES, 200),
    ]);
    expect(has(mask, PERMISSIONS.MANAGE_CHANNEL)).toBe(true);
    expect(has(mask, PERMISSIONS.CREATE_INVITES)).toBe(true);
    expect(has(mask, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
  });
});
