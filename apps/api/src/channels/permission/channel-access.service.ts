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
    channel: { id: string; workspaceId: string; isPrivate: boolean },
    userId: string,
  ): Promise<number> {
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
    channel: { id: string; workspaceId: string; isPrivate: boolean },
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

  /** Shortcut for the visibility check that the URL-path guard runs. */
  async requireVisibility(
    channel: { id: string; workspaceId: string; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    if (!channel.isPrivate) return;
    await this.requirePermission(channel, userId, Permission.READ);
  }
}
