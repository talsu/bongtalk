import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  pickTopHoistRoleId,
  sortHoistedRoles,
  type HoistedRoleInfo,
} from '../../../src/workspaces/members/member-hoist';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const OWNER: HoistedRoleInfo = { roleId: 'r-owner', name: 'OWNER', position: 500, colorHex: null };
const ADMIN: HoistedRoleInfo = { roleId: 'r-admin', name: 'ADMIN', position: 400, colorHex: null };
const STAFF: HoistedRoleInfo = {
  roleId: 'r-staff',
  name: 'Staff',
  position: 250,
  colorHex: '#5865f2',
};

// FR-P09 (task-068 · S95): hoist 계산 순수 함수.
describe('FR-P09 sortHoistedRoles', () => {
  it('orders by position DESC (highest role first)', () => {
    const sorted = sortHoistedRoles([STAFF, OWNER, ADMIN]);
    expect(sorted.map((r) => r.roleId)).toEqual(['r-owner', 'r-admin', 'r-staff']);
  });

  it('tie-breaks equal positions by roleId ASC for a stable order', () => {
    const a: HoistedRoleInfo = { roleId: 'r-aaa', name: 'A', position: 300, colorHex: null };
    const b: HoistedRoleInfo = { roleId: 'r-bbb', name: 'B', position: 300, colorHex: null };
    expect(sortHoistedRoles([b, a]).map((r) => r.roleId)).toEqual(['r-aaa', 'r-bbb']);
  });

  it('does not mutate the input array', () => {
    const input = [STAFF, OWNER];
    const before = input.map((r) => r.roleId);
    sortHoistedRoles(input);
    expect(input.map((r) => r.roleId)).toEqual(before);
  });
});

describe('FR-P09 pickTopHoistRoleId', () => {
  const sorted = sortHoistedRoles([OWNER, ADMIN, STAFF]);

  it('returns null when the member holds no hoisted role', () => {
    expect(pickTopHoistRoleId(sorted, new Set())).toBeNull();
  });

  it('returns the only hoisted role the member holds', () => {
    expect(pickTopHoistRoleId(sorted, new Set(['r-staff']))).toBe('r-staff');
  });

  it('picks the TOP (highest position) when the member holds multiple hoisted roles (dedup)', () => {
    // 멤버가 OWNER + Staff 둘 다 보유 → 최상위 OWNER(position 500) 그룹 1개만.
    expect(pickTopHoistRoleId(sorted, new Set(['r-staff', 'r-owner']))).toBe('r-owner');
    // ADMIN + Staff → ADMIN(400)이 Staff(250)보다 상위.
    expect(pickTopHoistRoleId(sorted, new Set(['r-staff', 'r-admin']))).toBe('r-admin');
  });

  it('ignores roleIds the member holds that are not hoisted', () => {
    // 보유 집합에 hoisted 목록에 없는 roleId 가 섞여 있어도 무시한다.
    expect(pickTopHoistRoleId(sorted, new Set(['r-not-hoisted', 'r-staff']))).toBe('r-staff');
    expect(pickTopHoistRoleId(sorted, new Set(['r-not-hoisted']))).toBeNull();
  });

  it('respects the position tie-break (roleId ASC) when top positions tie', () => {
    const a: HoistedRoleInfo = { roleId: 'r-aaa', name: 'A', position: 300, colorHex: null };
    const b: HoistedRoleInfo = { roleId: 'r-bbb', name: 'B', position: 300, colorHex: null };
    const s = sortHoistedRoles([a, b]);
    expect(pickTopHoistRoleId(s, new Set(['r-bbb', 'r-aaa']))).toBe('r-aaa');
  });
});
