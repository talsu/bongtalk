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
   *   base       = ROLE_BASELINE[role]
   *   channelOk  = isPrivate ? (any USER|ROLE allow applies)
   *                          : true
   *   allow      = base | channelAllow (only when channelOk)
   *   deny       = channelDeny  (union of every applicable override)
   *   effective  = allow & ~deny
   *
   * "channelOk" for private channels is the gate: a private channel's
   * workspace role baseline is SUPPRESSED until some override grants
   * access (USER principal OR the caller's ROLE). A public channel
   * behaves as before — role baseline straight through.
   *
   * DENY > ALLOW invariant is preserved: a USER-level deny bit can
   * never be overridden by a ROLE-level allow on the same channel.
   */
  static effective(input: EffectiveInput): number {
    const base = ROLE_BASELINE[input.role] ?? 0;

    const applicable = input.overrides.filter(
      (o) =>
        (o.principalType === 'USER' && o.principalId === input.userId) ||
        (o.principalType === 'ROLE' && o.principalId === input.role),
    );

    const channelAllow = applicable.reduce((m, o) => m | (o.allowMask ?? 0), 0);
    const channelDeny = applicable.reduce((m, o) => m | (o.denyMask ?? 0), 0);

    // Task-012 reviewer MED-6 fix: OWNER always has access to every
    // channel in their workspace, private or not. The three enforcement
    // sites (listByWorkspace, ChannelAccessGuard, ChannelAccessByIdGuard)
    // disagreed on this before; matrix-level bypass keeps them
    // consistent with one rule. Covers cases where the OWNER has no
    // creator-override row (transferOwnership, DB restore, etc.). DENY
    // still applies — an explicit USER-level self-deny from the OWNER
    // is a deliberate administrative action and should stick.
    if (input.role === 'OWNER') {
      return ROLE_BASELINE.OWNER & ~channelDeny;
    }

    const hasExplicitAllow = applicable.some((o) => (o.allowMask ?? 0) !== 0);
    const channelOk = input.isPrivate ? hasExplicitAllow : true;

    const allow = channelOk ? base | channelAllow : 0;
    return allow & ~channelDeny;
  }

  static has(effective: number, perm: Permission): boolean {
    return (effective & perm) === perm;
  }
}
