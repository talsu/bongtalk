import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { PermissionMatrix, Permission } from '../../auth/permissions';

/**
 * ACL helper for attachment routes that identify the channel via
 * request body / route param (not URL path). Task-012-B landed the
 * basic workspace-membership check here; task-012-E extends this to
 * check the full permission mask via PermissionMatrix (see
 * apps/api/src/auth/permissions.ts).
 *
 * Not a NestJS `CanActivate` guard because the channel id for
 * attachment routes comes from the request body, not a URL param, so
 * the route-level guard pattern doesn't fit. A service-level
 * injectable keeps the API the same (`await guard.requireX(channel,
 * userId)`).
 */
@Injectable()
export class ChannelAccessByIdGuard {
  constructor(private readonly prisma: PrismaService) {}

  async requireRead(
    channel: { id: string; workspaceId: string; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    await this.requirePermission(channel, userId, Permission.READ);
  }

  async requireUpload(
    channel: { id: string; workspaceId: string; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    await this.requirePermission(channel, userId, Permission.UPLOAD_ATTACHMENT);
  }

  /**
   * Core gate. Loads the workspace membership row + any channel-level
   * override rows for this user (direct USER override or the user's
   * ROLE), folds them through PermissionMatrix.effective, and throws
   * CHANNEL_NOT_VISIBLE when the bit isn't set.
   */
  private async requirePermission(
    channel: { id: string; workspaceId: string; isPrivate: boolean },
    userId: string,
    required: Permission,
  ): Promise<void> {
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

    const effective = PermissionMatrix.effective({
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

    if ((effective & required) !== required) {
      // Use CHANNEL_NOT_VISIBLE for a private channel the caller
      // doesn't see (no information leak beyond "403"); FORBIDDEN for
      // a public channel where the caller is a member but lacks the
      // specific bit (semantic difference matters for the E2E).
      throw new DomainError(
        channel.isPrivate ? ErrorCode.CHANNEL_NOT_VISIBLE : ErrorCode.FORBIDDEN,
        'insufficient permission',
      );
    }
  }
}
