import { describe, expect, it } from 'vitest';
import { WorkspaceRole } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  Permission,
  PermissionMatrix,
  ROLE_BASELINE,
} from '../../../src/auth/permissions';

const me = '11111111-1111-1111-1111-111111111111';

describe('PermissionMatrix.effective (task-012-D)', () => {
  it('public channel returns the full role baseline for OWNER', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.OWNER,
      isPrivate: false,
      userId: me,
      overrides: [],
    });
    expect(eff).toBe(ALL_PERMISSIONS);
  });

  it('public channel returns role baseline for MEMBER (read/write/delete-own/upload)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: false,
      userId: me,
      overrides: [],
    });
    expect(eff).toBe(ROLE_BASELINE.MEMBER);
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(true);
    expect(PermissionMatrix.has(eff, Permission.WRITE_MESSAGE)).toBe(true);
    expect(PermissionMatrix.has(eff, Permission.MANAGE_MEMBERS)).toBe(false);
  });

  it('private channel hides from MEMBER without any allow override', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: true,
      userId: me,
      overrides: [],
    });
    expect(eff).toBe(0);
  });

  it('private channel OPENS via USER-level allow override', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: true,
      userId: me,
      overrides: [
        {
          principalType: 'USER',
          principalId: me,
          allowMask: Permission.READ | Permission.WRITE_MESSAGE,
          denyMask: 0,
        },
      ],
    });
    // Role baseline applies (channelOk=true), plus the explicit
    // allow mask (which is a subset here). Result == baseline.
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(true);
    expect(PermissionMatrix.has(eff, Permission.WRITE_MESSAGE)).toBe(true);
  });

  it('private channel OPENS via ROLE-level allow override', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.ADMIN,
      isPrivate: true,
      userId: me,
      overrides: [
        {
          principalType: 'ROLE',
          principalId: 'ADMIN',
          allowMask: Permission.READ,
          denyMask: 0,
        },
      ],
    });
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(true);
  });

  it('USER-level deny wins over ROLE-level allow on the same channel (DENY > ALLOW)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: false,
      userId: me,
      overrides: [
        {
          principalType: 'ROLE',
          principalId: 'MEMBER',
          allowMask: Permission.WRITE_MESSAGE,
          denyMask: 0,
        },
        {
          principalType: 'USER',
          principalId: me,
          allowMask: 0,
          denyMask: Permission.WRITE_MESSAGE,
        },
      ],
    });
    expect(PermissionMatrix.has(eff, Permission.WRITE_MESSAGE)).toBe(false);
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(true);
  });

  it('overrides targeting a different USER or ROLE do not leak', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: true,
      userId: me,
      overrides: [
        {
          principalType: 'USER',
          principalId: '22222222-2222-2222-2222-222222222222',
          allowMask: Permission.READ,
          denyMask: 0,
        },
        {
          principalType: 'ROLE',
          principalId: 'ADMIN',
          allowMask: Permission.READ,
          denyMask: 0,
        },
      ],
    });
    expect(eff).toBe(0);
  });
});
