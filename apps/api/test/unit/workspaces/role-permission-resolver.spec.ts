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

  it('④ role tier: any allow beats any deny (allow=OR · deny=OR · allow wins)', () => {
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
    // S61 fix-forward MAJOR-1: 역할 tier 는 모든 deny 를 OR, 모든 allow 를 OR 누적한 뒤
    // (deny → allow) 일괄 적용한다. 따라서 어느 역할이든 allow 한 비트는 유지된다.
    expect(has(mask, PERMISSIONS.SEND_MESSAGES)).toBe(true);
  });

  it('④ role tier: a HIGHER-position deny does NOT override a LOWER-position allow', () => {
    // PRD 정본(MAJOR-1): 역할 tier 안에서는 position 과 무관하게 allow=OR 가 deny=OR 를
    // 이긴다. 종전 순차 적용은 "상위 deny 가 나중에 적용돼 하위 allow 를 덮는" 경로가
    // 있었으나(예: 상위 역할이 deny 한 비트), 누적-후-일괄 적용으로 그 경로를 닫는다.
    const low = role('low', 0n, 100);
    const high = role('high', 0n, 300);
    const mask = resolveChannelPermissions({
      everyone,
      memberRoles: [low, high],
      roleOverwrites: new Map([
        ['low', { allow: PERMISSIONS.SEND_MESSAGES, deny: 0n }],
        ['high', { allow: 0n, deny: PERMISSIONS.SEND_MESSAGES }],
      ]),
    });
    // 상위(high) 역할이 deny 했지만 하위(low) 역할이 allow → tier allow=OR 가 살린다.
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
