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

  it('private channel STAYS HIDDEN when a non-READ bit (BYPASS_SLOWMODE) is granted without READ (S15 HIGH fix)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: true,
      userId: me,
      overrides: [
        {
          principalType: 'USER',
          principalId: me,
          // Granting only BYPASS_SLOWMODE must NOT restore the MEMBER baseline
          // / open private-channel visibility — the gate requires explicit READ.
          allowMask: Permission.BYPASS_SLOWMODE,
          denyMask: 0,
        },
      ],
    });
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(false);
    expect(PermissionMatrix.has(eff, Permission.WRITE_MESSAGE)).toBe(false);
    // The granted bit itself is present (it just doesn't open the channel).
    expect(PermissionMatrix.has(eff, Permission.BYPASS_SLOWMODE)).toBe(true);
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

  it('OWNER bypasses private-channel gate even with no overrides (reviewer MED-6)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.OWNER,
      isPrivate: true,
      userId: me,
      overrides: [],
    });
    expect(eff).toBe(ALL_PERMISSIONS);
  });

  it('OWNER still respects an explicit DENY (administrative self-lockout is deliberate)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.OWNER,
      isPrivate: true,
      userId: me,
      overrides: [
        {
          principalType: 'USER',
          principalId: me,
          allowMask: 0,
          denyMask: Permission.DELETE_ANY_MESSAGE,
        },
      ],
    });
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(true);
    expect(PermissionMatrix.has(eff, Permission.DELETE_ANY_MESSAGE)).toBe(false);
  });
});

/**
 * S14 (FR-CH-11): 5단계 권한 오버라이드 계산 순서 고정.
 *
 * 우선순위(내림차순): 개인 DENY > 개인 ALLOW > 역할 DENY > 역할 ALLOW > 서버 기본.
 * 적용은 그 역순으로 누적한다:
 *   mask = base
 *   mask |= roleAllow      (역할 ALLOW)
 *   mask &= ~roleDeny      (역할 DENY)
 *   mask |= userAllow      (개인 ALLOW) — 역할 DENY 를 이긴다
 *   mask &= ~userDeny      (개인 DENY) — 최종 최우선
 *
 * 기존 effective 는 모든 ALLOW 를 합치고 모든 DENY 를 합쳐 마지막에 한 번
 * `allow & ~deny` 로 적용했다. 그 모델에서는 "개인 ALLOW 가 역할 DENY 를 이긴다"
 * 를 표현할 수 없다(역할 DENY 가 개인 ALLOW 와 함께 union 되어 항상 이김).
 * 아래 케이스가 그 경계를 고정한다.
 */
describe('PermissionMatrix.effective — S14 FR-CH-11 5단계 순서 고정', () => {
  it('개인 ALLOW 가 역할 DENY 를 이긴다 (priority: user ALLOW > role DENY)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: false,
      userId: me,
      overrides: [
        {
          principalType: 'ROLE',
          principalId: 'MEMBER',
          allowMask: 0,
          denyMask: Permission.WRITE_MESSAGE,
        },
        {
          principalType: 'USER',
          principalId: me,
          allowMask: Permission.WRITE_MESSAGE,
          denyMask: 0,
        },
      ],
    });
    // 개인 ALLOW(WRITE) 가 역할 DENY(WRITE) 보다 우선 → WRITE 유지.
    expect(PermissionMatrix.has(eff, Permission.WRITE_MESSAGE)).toBe(true);
  });

  it('개인 DENY 가 개인 ALLOW 보다 우선한다 (동일 비트, user DENY > user ALLOW)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: false,
      userId: me,
      overrides: [
        {
          principalType: 'USER',
          principalId: me,
          allowMask: Permission.MANAGE_CHANNEL,
          denyMask: Permission.MANAGE_CHANNEL,
        },
      ],
    });
    // 동일 프린시펄·동일 비트에서 DENY 가 ALLOW 보다 나중(우선) 적용.
    expect(PermissionMatrix.has(eff, Permission.MANAGE_CHANNEL)).toBe(false);
  });

  it('역할 DENY 가 역할 ALLOW 보다 우선한다 (동일 비트, role DENY > role ALLOW)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: false,
      userId: me,
      overrides: [
        {
          principalType: 'ROLE',
          principalId: 'MEMBER',
          allowMask: Permission.MANAGE_CHANNEL,
          denyMask: Permission.MANAGE_CHANNEL,
        },
      ],
    });
    expect(PermissionMatrix.has(eff, Permission.MANAGE_CHANNEL)).toBe(false);
  });

  it('역할 ALLOW 가 서버 기본에 비트를 더한다 (role ALLOW > base)', () => {
    const eff = PermissionMatrix.effective({
      role: WorkspaceRole.MEMBER,
      isPrivate: false,
      userId: me,
      overrides: [
        {
          principalType: 'ROLE',
          principalId: 'MEMBER',
          // S61: MEMBER 기본에는 없는 MANAGE_CHANNEL 을 역할 ALLOW 로 부여(PIN_MESSAGE 폐기).
          allowMask: Permission.MANAGE_CHANNEL,
          denyMask: 0,
        },
      ],
    });
    expect(PermissionMatrix.has(eff, Permission.MANAGE_CHANNEL)).toBe(true);
    // 기존 baseline 비트는 유지.
    expect(PermissionMatrix.has(eff, Permission.READ)).toBe(true);
  });

  it('개인 DENY 가 역할 ALLOW + 서버 기본을 모두 이긴다 (최우선 DENY)', () => {
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
});
