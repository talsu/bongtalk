import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { Permission, PermissionMatrix } from '../../auth/permissions';

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
}
