import { Injectable } from '@nestjs/common';
import type { WorkspaceRole } from '@prisma/client';
import { PERMISSIONS } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { Permission, PermissionMatrix } from '../../auth/permissions';

/**
 * S44 (FR-MN-02 / FR-MN-16 / ADR-4): `MENTION_EVERYONE` 카탈로그 비트(0x0080).
 *
 * ⚠️ D12 carryover: 집행 enum(`auth/permissions.ts`)의 0x0080 은 PIN_MESSAGE 라
 * 동일 비트 위치를 공유한다. 멘션 게이트는 PRD 지시대로 **카탈로그 비트**(여기
 * 정의)를 직접 검사한다. `ChannelPermissionOverride.allow/denyMask`(Int)에 이
 * 비트가 켜져 있으면 MENTION_EVERYONE 권한 부여/박탈로 해석한다. number 비트필드
 * 로 다루므로 BigInt 카탈로그 값을 Number 로 좁혀 모듈 상수로 고정한다(0x0080).
 */
const MENTION_EVERYONE_BIT = Number(PERMISSIONS.MENTION_EVERYONE);

/**
 * S44: 역할별 `MENTION_EVERYONE` 기본값(base). OWNER/ADMIN 은 on, MEMBER 는 off.
 * 채널 override 가 이 base 위에 5단계 fold 로 누적된다.
 */
const MENTION_EVERYONE_ROLE_BASE: Record<WorkspaceRole, number> = {
  OWNER: MENTION_EVERYONE_BIT,
  ADMIN: MENTION_EVERYONE_BIT,
  MEMBER: 0,
};

/**
 * Task-014-A (task-012-follow-13 closure): single source of truth for
 * channel ACL. Both `ChannelAccessGuard` (loads `:chid` from the URL
 * path, enforces visibility + archived state) and `ChannelAccessByIdGuard`
 * (called from controllers when the channel id lives in the body) now
 * delegate here. The previous guards each had their own override-lookup
 * + mask-compute logic; diverging implementations meant a permission
 * model change required 2-file diffs and 012-review caught one such
 * drift. Folding it into one service keeps the permission model
 * testable in isolation.
 */
@Injectable()
export class ChannelAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute the caller's effective permission mask on a channel.
   * Throws `WORKSPACE_NOT_MEMBER` when the caller isn't a member of
   * the channel's workspace — guards above this are expected to have
   * proven workspace membership already, but we repeat the check here
   * because callers like the attachment presign endpoint run without
   * `WorkspaceMemberGuard` upstream.
   */
  async resolveEffective(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<number> {
    // task-034-A: DIRECT channels have workspaceId=null. Access is
    // expressed solely via ChannelPermissionOverride (USER rows the
    // DirectMessagesService creates) — skip the workspace-member gate.
    if (channel.workspaceId === null) {
      const overrides = await this.prisma.channelPermissionOverride.findMany({
        where: { channelId: channel.id, principalType: 'USER', principalId: userId },
      });
      let allow = 0;
      let deny = 0;
      for (const o of overrides) {
        allow |= o.allowMask;
        deny |= o.denyMask;
      }
      return allow & ~deny;
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'not a workspace member');
    }
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId: channel.id,
        OR: [
          { principalType: 'USER', principalId: userId },
          { principalType: 'ROLE', principalId: member.role },
        ],
      },
      select: { principalType: true, principalId: true, allowMask: true, denyMask: true },
    });
    return PermissionMatrix.effective({
      role: member.role,
      isPrivate: channel.isPrivate,
      userId,
      overrides: overrides.map((o) => ({
        principalType: o.principalType as 'USER' | 'ROLE',
        principalId: o.principalId,
        allowMask: o.allowMask,
        denyMask: o.denyMask,
      })),
    });
  }

  /**
   * Throws the right error code when the caller doesn't have `required`.
   * Private channels get `CHANNEL_NOT_VISIBLE` (no information leak);
   * public channels where the member exists but lacks the bit get
   * `FORBIDDEN` so the E2E can distinguish 404-style from 403-style.
   */
  async requirePermission(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
    required: Permission,
  ): Promise<void> {
    const effective = await this.resolveEffective(channel, userId);
    if ((effective & required) !== required) {
      throw new DomainError(
        channel.isPrivate ? ErrorCode.CHANNEL_NOT_VISIBLE : ErrorCode.FORBIDDEN,
        'insufficient permission',
      );
    }
  }

  /**
   * S15 (FR-CH-08): 호출자가 채널에서 특정 권한 비트를 가지는지 boolean 으로
   * 반환한다(throw 없이). 슬로우모드 BYPASS_SLOWMODE 면제 판정에 사용한다.
   */
  async hasPermission(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
    required: Permission,
  ): Promise<boolean> {
    const effective = await this.resolveEffective(channel, userId);
    return (effective & required) === required;
  }

  /** Shortcut for the visibility check that the URL-path guard runs. */
  async requireVisibility(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    if (!channel.isPrivate) return;
    await this.requirePermission(channel, userId, Permission.READ);
  }

  /**
   * S13 (FR-CH-19): ANNOUNCEMENT 채널 게시 게이트.
   *
   * 비-ANNOUNCEMENT 채널은 통과(no-op). ANNOUNCEMENT 채널은 게시 권한
   * (WRITE_MESSAGE 비트)을 가진 역할만 게시할 수 있다 — OWNER/ADMIN 은
   * ROLE_BASELINE 에 WRITE_MESSAGE 가 있으므로 통과하고, MEMBER 는 기본적으로
   * (ROLE_BASELINE 에는 WRITE_MESSAGE 가 있지만) 공지 채널에 한해 차단된다.
   *
   * 차단 예외: 채널에 명시적 ALLOW(WRITE_MESSAGE) 오버라이드(USER 또는 ROLE
   * 프린시펄)가 있으면 "허용 역할/사용자" 로 보고 통과시킨다 — "OWNER/ADMIN/
   * 허용역할만 게시" 요구의 '허용역할' 경로. resolveEffective 가 비트를
   * 계산하지만, MEMBER 기본 WRITE_MESSAGE 억제는 ANNOUNCEMENT 에 한정하므로
   * 여기서 타입별로 분기한다(전역 ROLE_BASELINE 은 건드리지 않는다 — TEXT
   * 채널 회귀 방지).
   *
   * 권한 부족 시 CHANNEL_POSTING_RESTRICTED(403) 를 던진다 — 일반 FORBIDDEN
   * 과 구분해 클라이언트가 "공지 채널 게시 제한" UI 로 분기할 수 있게 한다.
   */
  async requireAnnouncementPostingAllowed(
    channel: { id: string; type: string },
    userId: string,
    role: 'OWNER' | 'ADMIN' | 'MEMBER',
  ): Promise<void> {
    if (channel.type !== 'ANNOUNCEMENT') return;
    // OWNER/ADMIN 은 항상 게시 가능.
    if (role === 'OWNER' || role === 'ADMIN') return;
    // MEMBER: 채널에 명시적 ALLOW(WRITE_MESSAGE) 오버라이드(USER 또는 본인
    // ROLE)가 있어야 게시 허용. 없으면 공지 채널 게시 제한.
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId: channel.id,
        OR: [
          { principalType: 'USER', principalId: userId },
          { principalType: 'ROLE', principalId: role },
        ],
      },
      select: { allowMask: true, denyMask: true },
    });
    let allow = 0;
    let deny = 0;
    for (const o of overrides) {
      allow |= o.allowMask;
      deny |= o.denyMask;
    }
    const effective = (allow & ~deny) >>> 0;
    if ((effective & Permission.WRITE_MESSAGE) !== Permission.WRITE_MESSAGE) {
      throw new DomainError(
        ErrorCode.CHANNEL_POSTING_RESTRICTED,
        'this announcement channel only allows admins / granted roles to post',
      );
    }
  }

  /**
   * S44 (FR-MN-02 / FR-MN-16 / ADR-4): 채널에서 호출자가 `@everyone`/`@here`/
   * `@channel` 멘션 fanout 권한(`MENTION_EVERYONE`, 카탈로그 비트 0x0080)을
   * 가지는지 boolean 으로 판정한다.
   *
   * S40 FR-RE07 fix-forward 와 동일한 ADR-4 5단계 fold:
   *   base → roleAllow → roleDeny → userAllow → userDeny
   * base 는 역할 기본값(OWNER/ADMIN on, MEMBER off)이고, 채널 override 의
   * allow/deny 마스크에서 MENTION_EVERYONE 비트만 추출해 누적한다. 따라서
   * MEMBER 도 override allow 면 권한을 얻고, OWNER/ADMIN 도 override deny 면
   * 권한을 잃는다(개인 DENY 가 역할 ALLOW 를 이긴다).
   *
   * DM 채널(workspaceId=null)은 워크스페이스 멤버/역할 개념이 없어 항상 false 다
   * — `@everyone` 자체가 무의미하고 extractMentions 도 false 를 반환한다.
   *
   * ⚠️ 비트 재사용 주석(S44 fix-forward · D12 carryover): 카탈로그 MENTION_EVERYONE
   * 은 0x0080 이고, 집행 enum(auth/permissions.ts)의 0x0080 은 PIN_MESSAGE 다(동일
   * 비트 위치 공유). 그러나 **PIN_MESSAGE 는 집행 경로 어디서도 hasPermission/require
   * 로 검사되지 않는 dead bit** 이며(pin/unpin 은 OWNER/ADMIN 역할 검사로만 게이트),
   * 따라서 MENTION_EVERYONE 의 0x0080 재사용은 안전하다(S40 MANAGE_CHANNEL 선례 동일).
   * 카탈로그 MENTION_EVERYONE 비트의 PIN_MESSAGE enum 분리는 D12 수렴 시 처리한다.
   */
  async resolveMentionEveryone(
    channel: { id: string; workspaceId: string | null },
    userId: string,
    role: WorkspaceRole,
  ): Promise<boolean> {
    if (channel.workspaceId === null) return false;
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId: channel.id,
        OR: [
          { principalType: 'USER', principalId: userId },
          { principalType: 'ROLE', principalId: role },
        ],
      },
      select: { principalType: true, principalId: true, allowMask: true, denyMask: true },
    });
    let roleAllow = 0;
    let roleDeny = 0;
    let userAllow = 0;
    let userDeny = 0;
    for (const o of overrides) {
      if (o.principalType === 'USER' && o.principalId === userId) {
        userAllow |= o.allowMask;
        userDeny |= o.denyMask;
      } else if (o.principalType === 'ROLE' && o.principalId === role) {
        roleAllow |= o.allowMask;
        roleDeny |= o.denyMask;
      }
    }
    // ADR-4 5단계 fold — MENTION_EVERYONE 비트만 누적(다른 비트는 무관).
    let mask = MENTION_EVERYONE_ROLE_BASE[role] ?? 0;
    mask |= roleAllow & MENTION_EVERYONE_BIT;
    mask &= ~(roleDeny & MENTION_EVERYONE_BIT);
    mask |= userAllow & MENTION_EVERYONE_BIT;
    mask &= ~(userDeny & MENTION_EVERYONE_BIT);
    return (mask & MENTION_EVERYONE_BIT) === MENTION_EVERYONE_BIT;
  }
}
