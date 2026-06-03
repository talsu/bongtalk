import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  SYSTEM_ROLE_POSITION,
  PERMISSIONS,
  has,
  toStoragePermissions,
  fromStoragePermissions,
  RoleNameSchema,
  ColorHexSchema,
  PermissionsBitfieldSchema,
} from '@qufox/shared-types';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

// S61 (FR-RM01/02): 시스템 역할 정의가 마이그레이션 backfill 값과 정합하는지 검증.
describe('S61 system role definitions', () => {
  it('defines exactly the 5 system roles', () => {
    expect([...SYSTEM_ROLE_NAMES]).toEqual(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']);
  });

  it('positions strictly descend OWNER>ADMIN>MODERATOR>MEMBER>GUEST', () => {
    expect(SYSTEM_ROLE_POSITION.OWNER).toBeGreaterThan(SYSTEM_ROLE_POSITION.ADMIN);
    expect(SYSTEM_ROLE_POSITION.ADMIN).toBeGreaterThan(SYSTEM_ROLE_POSITION.MODERATOR);
    expect(SYSTEM_ROLE_POSITION.MODERATOR).toBeGreaterThan(SYSTEM_ROLE_POSITION.MEMBER);
    expect(SYSTEM_ROLE_POSITION.MEMBER).toBeGreaterThan(SYSTEM_ROLE_POSITION.GUEST);
  });

  it('OWNER permissions = ADMINISTRATOR bit', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.OWNER).toBe(PERMISSIONS.ADMINISTRATOR);
    // ADMINISTRATOR holder passes every flag check.
    expect(has(SYSTEM_ROLE_PERMISSIONS.OWNER, PERMISSIONS.MANAGE_CHANNEL)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.OWNER, PERMISSIONS.SEND_MESSAGES)).toBe(true);
  });

  // 마이그레이션 backfill 의 하드코딩 값과 1:1 정합(보고서 표 참조).
  it('matches the migration-seeded bitfield values', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).toBe(8191n); // 0x1FFF
    expect(SYSTEM_ROLE_PERMISSIONS.MODERATOR).toBe(7423n); // 0x1CFF
    expect(SYSTEM_ROLE_PERMISSIONS.MEMBER).toBe(3191n); // 0x0C77
    expect(SYSTEM_ROLE_PERMISSIONS.GUEST).toBe(39n); // 0x0027
  });

  it('ADMIN has MANAGE_CHANNEL/MANAGE_WEBHOOKS; MODERATOR does not', () => {
    expect(has(SYSTEM_ROLE_PERMISSIONS.ADMIN, PERMISSIONS.MANAGE_CHANNEL)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.ADMIN, PERMISSIONS.MANAGE_WEBHOOKS)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.MANAGE_CHANNEL)).toBe(false);
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.MANAGE_WEBHOOKS)).toBe(false);
    // MODERATOR keeps message-management + slowmode bypass.
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.MANAGE_MESSAGES)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.BYPASS_SLOWMODE)).toBe(true);
  });

  it('GUEST is read/post/react only — no attach', () => {
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.ADD_REACTIONS)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.ATTACH_FILES)).toBe(false);
  });
});

// S61 (FR-RM02): PostgreSQL signed bigint 저장 ↔ 부호 없는 논리값 왕복.
describe('S61 storage permission round-trip', () => {
  it('ADMINISTRATOR (1<<63) stores as signed -(2^63) and recovers losslessly', () => {
    const stored = toStoragePermissions(PERMISSIONS.ADMINISTRATOR);
    expect(stored).toBe(-9223372036854775808n);
    expect(fromStoragePermissions(stored)).toBe(PERMISSIONS.ADMINISTRATOR);
  });

  it('non-ADMINISTRATOR masks are identity through storage', () => {
    for (const v of [0n, 8191n, 7423n, 3191n, 39n]) {
      expect(toStoragePermissions(v)).toBe(v);
      expect(fromStoragePermissions(v)).toBe(v);
    }
  });

  it('round-trip is total over every system role', () => {
    for (const name of SYSTEM_ROLE_NAMES) {
      const perm = SYSTEM_ROLE_PERMISSIONS[name];
      expect(fromStoragePermissions(toStoragePermissions(perm))).toBe(perm);
    }
  });
});

// S61 (ADR-11): DTO 스키마 검증.
describe('S61 role DTO schemas', () => {
  it('RoleNameSchema trims and bounds length', () => {
    expect(RoleNameSchema.parse('  Mods  ')).toBe('Mods');
    expect(() => RoleNameSchema.parse('')).toThrow();
    expect(() => RoleNameSchema.parse('   ')).toThrow();
    expect(() => RoleNameSchema.parse('x'.repeat(65))).toThrow();
  });

  it('ColorHexSchema accepts #RRGGBB only', () => {
    expect(ColorHexSchema.parse('#a1b2c3')).toBe('#a1b2c3');
    expect(() => ColorHexSchema.parse('a1b2c3')).toThrow();
    expect(() => ColorHexSchema.parse('#fff')).toThrow();
  });

  it('PermissionsBitfieldSchema accepts non-negative integer strings only', () => {
    expect(PermissionsBitfieldSchema.parse('0')).toBe('0');
    expect(PermissionsBitfieldSchema.parse('9223372036854775808')).toBe('9223372036854775808');
    expect(() => PermissionsBitfieldSchema.parse('-1')).toThrow();
    expect(() => PermissionsBitfieldSchema.parse('01')).toThrow();
    expect(() => PermissionsBitfieldSchema.parse('1.5')).toThrow();
  });
});
