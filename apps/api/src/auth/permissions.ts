import { WorkspaceRole } from '@prisma/client';

/**
 * Task-012-D: channel-level permission masks.
 *
 * Bitfield so `effective = allow & ~deny` is a single int op per
 * check. Slots below 0x0100 are reserved for the current MVP surface;
 * 0x0100..0x8000 are reserved for voice/video/screenshare when those
 * channel types land.
 *
 * DENY beats ALLOW. The matrix below formalises the 002-workspace
 * baseline (role → workspace-wide mask) plus the task-012-D channel
 * override layer (allow/deny per principal=ROLE|USER).
 */

export enum Permission {
  READ = 0x0001,
  WRITE_MESSAGE = 0x0002,
  DELETE_OWN_MESSAGE = 0x0004,
  DELETE_ANY_MESSAGE = 0x0008,
  MANAGE_MEMBERS = 0x0010,
  MANAGE_CHANNEL = 0x0020,
  UPLOAD_ATTACHMENT = 0x0040,
  PIN_MESSAGE = 0x0080,
  // 0x0100+ reserved for future voice / video channel types.
}

/** Convenience: every bit set. */
export const ALL_PERMISSIONS =
  Permission.READ |
  Permission.WRITE_MESSAGE |
  Permission.DELETE_OWN_MESSAGE |
  Permission.DELETE_ANY_MESSAGE |
  Permission.MANAGE_MEMBERS |
  Permission.MANAGE_CHANNEL |
  Permission.UPLOAD_ATTACHMENT |
  Permission.PIN_MESSAGE;

/**
 * Workspace-role baseline. This is the mask every channel starts
 * with before its overrides apply. 002's role hierarchy is
 * OWNER > ADMIN > MEMBER; OWNER gets everything, ADMIN gets
 * almost everything except the management bits that only OWNER
 * should touch (OWNER is the only one who can promote ADMIN → OWNER
 * via transferOwnership — the MANAGE_MEMBERS bit here covers
 * role-change below OWNER).
 */
export const ROLE_BASELINE: Record<WorkspaceRole, number> = {
  OWNER: ALL_PERMISSIONS,
  ADMIN:
    Permission.READ |
    Permission.WRITE_MESSAGE |
    Permission.DELETE_OWN_MESSAGE |
    Permission.DELETE_ANY_MESSAGE |
    Permission.MANAGE_MEMBERS |
    Permission.MANAGE_CHANNEL |
    Permission.UPLOAD_ATTACHMENT |
    Permission.PIN_MESSAGE,
  MEMBER:
    Permission.READ |
    Permission.WRITE_MESSAGE |
    Permission.DELETE_OWN_MESSAGE |
    Permission.UPLOAD_ATTACHMENT,
};

export interface ChannelOverride {
  principalType: 'USER' | 'ROLE';
  principalId: string;
  allowMask: number;
  denyMask: number;
}

export interface EffectiveInput {
  role: WorkspaceRole;
  isPrivate: boolean;
  userId: string;
  overrides: ChannelOverride[];
}

export class PermissionMatrix {
  /**
   * Compute the effective permission mask for (user, channel).
   *
   * S14 (FR-CH-11): 5단계 권한 오버라이드 계산. 우선순위 내림차순은
   *   개인 DENY > 개인 ALLOW > 역할 DENY > 역할 ALLOW > 서버 기본
   * 이며, 적용은 그 역순으로 누적한다(Discord ADR-4 모델과 동일 순서):
   *
   *   mask  = base                      // 서버 기본(ROLE_BASELINE)
   *   mask |= roleAllow                 // 역할 ALLOW (base 에 비트 추가)
   *   mask &= ~roleDeny                 // 역할 DENY  (역할 ALLOW/기본 비트 제거)
   *   mask |= userAllow                 // 개인 ALLOW (역할 DENY 를 이김)
   *   mask &= ~userDeny                 // 개인 DENY  (최우선 — 모든 ALLOW 제거)
   *
   * 이 순서가 보장하는 경계:
   *   - 개인 ALLOW 가 역할 DENY 를 이긴다(userAllow 가 roleDeny 뒤에 OR).
   *   - 개인 DENY 가 개인 ALLOW 보다 우선한다(userDeny 가 가장 마지막 AND-NOT).
   *   - 역할 DENY 가 역할 ALLOW 보다 우선한다(roleDeny 가 roleAllow 뒤에 적용).
   *
   * (012 의 단일 `allow & ~deny` 폴드는 모든 ALLOW/DENY 를 각각 union 한 뒤
   *  한 번에 적용했기 때문에 "개인 ALLOW > 역할 DENY" 경계를 표현하지
   *  못했다 — S14 에서 단계별 누적으로 교정.)
   *
   * "channelOk" for private channels is the visibility gate: a private
   * channel's workspace role baseline is SUPPRESSED (base=0) until some
   * applicable override grants an explicit ALLOW (USER principal OR the
   * caller's ROLE). A public channel behaves as before — role baseline
   * straight through. The 5-stage fold then runs on top of the gated base.
   */
  static effective(input: EffectiveInput): number {
    const baseline = ROLE_BASELINE[input.role] ?? 0;

    const userOverrides = input.overrides.filter(
      (o) => o.principalType === 'USER' && o.principalId === input.userId,
    );
    const roleOverrides = input.overrides.filter(
      (o) => o.principalType === 'ROLE' && o.principalId === input.role,
    );

    const roleAllow = roleOverrides.reduce((m, o) => m | (o.allowMask ?? 0), 0);
    const roleDeny = roleOverrides.reduce((m, o) => m | (o.denyMask ?? 0), 0);
    const userAllow = userOverrides.reduce((m, o) => m | (o.allowMask ?? 0), 0);
    const userDeny = userOverrides.reduce((m, o) => m | (o.denyMask ?? 0), 0);

    // Task-012 reviewer MED-6 fix: OWNER always has access to every
    // channel in their workspace, private or not. The three enforcement
    // sites (listByWorkspace, ChannelAccessGuard, ChannelAccessByIdGuard)
    // disagreed on this before; matrix-level bypass keeps them
    // consistent with one rule. Covers cases where the OWNER has no
    // creator-override row (transferOwnership, DB restore, etc.). DENY
    // still applies — an explicit DENY (user or role) from the OWNER is a
    // deliberate administrative action and should stick. The 5-stage fold
    // honours the same precedence on the full OWNER baseline.
    if (input.role === 'OWNER') {
      return this.fold(ROLE_BASELINE.OWNER, roleAllow, roleDeny, userAllow, userDeny);
    }

    // Private-channel visibility gate: base is suppressed until an
    // explicit ALLOW grants access. Both USER and ROLE allows count.
    const hasExplicitAllow = userAllow !== 0 || roleAllow !== 0;
    const channelOk = input.isPrivate ? hasExplicitAllow : true;
    const base = channelOk ? baseline : 0;

    return this.fold(base, roleAllow, roleDeny, userAllow, userDeny);
  }

  /**
   * S14 (FR-CH-11): 단계별 누적. 입력 순서가 곧 우선순위(나중 = 우선).
   * `>>> 0` 로 32비트 부호 없는 정수로 정규화(집행 비트필드는 0xFF 범위).
   */
  private static fold(
    base: number,
    roleAllow: number,
    roleDeny: number,
    userAllow: number,
    userDeny: number,
  ): number {
    let mask = base;
    mask |= roleAllow;
    mask &= ~roleDeny;
    mask |= userAllow;
    mask &= ~userDeny;
    return mask >>> 0;
  }

  static has(effective: number, perm: Permission): boolean {
    return (effective & perm) === perm;
  }
}
