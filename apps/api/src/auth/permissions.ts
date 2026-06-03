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
  // S61 (D12 / 0x80 분리 — S44/S51 carryover 해소): 종전 PIN_MESSAGE=0x80 은
  // 집행 경로 어디서도 검사되지 않는 dead bit 였고(핀 게이트는 Channel.memberCanPin
  // 컬럼이 직접 담당), 카탈로그 MENTION_EVERYONE(0x80)과 비트 위치가 충돌했다.
  // PIN_MESSAGE 를 폐기해 override mask 컬럼의 0x80 비트가 오직 카탈로그
  // MENTION_EVERYONE(channel-access.service.resolveMentionEveryone)만을 의미하도록
  // 분리한다. 채널 핀 권한은 Channel.memberCanPin(S51) 게이트가 유지한다.
  // 0x0080 은 카탈로그 MENTION_EVERYONE 전용으로 예약(집행 enum 에서는 비워둠).
  // S15 (FR-CH-08): 슬로우모드 면제 비트. 보유자는 송신 경로의 slowmode
  // TTL 게이트를 우회한다(BYPASS_SLOWMODE). OWNER/ADMIN baseline 에 기본
  // 포함되며, 채널 override(USER/ROLE)로도 부여할 수 있다. shared-types 카탈로그의
  // BYPASS_SLOWMODE(0x1000)와 비트 위치는 다르나, 집행 비트필드는 본 enum 이
  // 단일 출처다(0x0100 은 종전 voice 예약 슬롯 — 현재 미사용이라 슬로우모드에 할당).
  BYPASS_SLOWMODE = 0x0100,
  // 0x0200+ reserved for future voice / video channel types.
}

/** Convenience: every bit set. S61: PIN_MESSAGE(0x80) 폐기 — 더 이상 포함하지 않는다. */
export const ALL_PERMISSIONS =
  Permission.READ |
  Permission.WRITE_MESSAGE |
  Permission.DELETE_OWN_MESSAGE |
  Permission.DELETE_ANY_MESSAGE |
  Permission.MANAGE_MEMBERS |
  Permission.MANAGE_CHANNEL |
  Permission.UPLOAD_ATTACHMENT |
  Permission.BYPASS_SLOWMODE;

/**
 * Workspace-role baseline. This is the mask every channel starts
 * with before its overrides apply.
 *
 * S61 (D12 / FR-RM01): 시스템 역할이 3단계 → 5단계로 확장됨에 따라 MODERATOR /
 * GUEST 의 집행 baseline 을 추가한다. 이 baseline 은 shared-types
 * SYSTEM_ROLE_PERMISSIONS(ADR-4 카탈로그 BigInt) 와 의미적으로 정합하나, 집행
 * 비트필드(이 enum)의 비트 위치로 표현한다(채널 ACL 게이트가 검사하는 비트만 의미).
 *   - OWNER     : 모든 집행 비트(ALL_PERMISSIONS) + 매트릭스 레벨 OWNER 우회.
 *   - ADMIN     : 관리 비트 전반 + 슬로우모드 면제(PIN_MESSAGE 폐기).
 *   - MODERATOR : 메시지 삭제 권한 + 슬로우모드 면제(멤버/채널 관리는 제외).
 *   - MEMBER    : 일반 참여(조회·전송·자기메시지삭제·첨부).
 *   - GUEST     : 최소 참여(조회·전송) — 첨부/삭제 불가.
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
    // S15 (FR-CH-08): ADMIN 은 슬로우모드 면제. OWNER 는 ALL_PERMISSIONS 로 자동 포함.
    Permission.BYPASS_SLOWMODE,
  MODERATOR:
    Permission.READ |
    Permission.WRITE_MESSAGE |
    Permission.DELETE_OWN_MESSAGE |
    Permission.DELETE_ANY_MESSAGE |
    Permission.UPLOAD_ATTACHMENT |
    Permission.BYPASS_SLOWMODE,
  MEMBER:
    Permission.READ |
    Permission.WRITE_MESSAGE |
    Permission.DELETE_OWN_MESSAGE |
    Permission.UPLOAD_ATTACHMENT,
  GUEST: Permission.READ | Permission.WRITE_MESSAGE,
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

    // Private-channel visibility gate: base is suppressed until an explicit
    // READ allow grants access. review S15 HIGH fix: previously ANY allow bit
    // (`userAllow !== 0 || roleAllow !== 0`) opened the channel — so granting a
    // narrow permission like BYPASS_SLOWMODE alone accidentally restored the full
    // MEMBER baseline (READ|WRITE|…) and exposed the private channel. Require the
    // READ bit specifically; non-READ grants no longer leak visibility.
    const hasExplicitRead = ((userAllow | roleAllow) & Permission.READ) === Permission.READ;
    const channelOk = input.isPrivate ? hasExplicitRead : true;
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
