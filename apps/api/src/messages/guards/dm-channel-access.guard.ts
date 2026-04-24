import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { ChannelAccessService } from '../../channels/permission/channel-access.service';
import { Permission } from '../../auth/permissions';

/**
 * Gate for `/me/dms/:channelId/messages` — the workspace-free DM
 * surface. Loads the channel by id, verifies it is DIRECT, and checks
 * the caller's USER-level ALLOW override for at least READ (the send
 * endpoint checks WRITE separately inside the service via the same
 * resolver). Pins `req.channel` + `req.dmChannelEffectiveMask` so the
 * controller can gate mutations without a second DB hit.
 *
 * Independent of WorkspaceMemberGuard — a zero-workspace user must be
 * able to DM a friend whose membership topology is unknown.
 */
@Injectable()
export class DmChannelAccessGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ChannelAccessService) private readonly access: ChannelAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: { id: string };
        params: Record<string, string>;
        channel?: unknown;
        dmChannelEffectiveMask?: number;
      }
    >();
    if (!req.user) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'authentication required');
    }
    const channelId = req.params.channelId;
    if (!channelId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'channel id missing');
    }
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        type: true,
        archivedAt: true,
        deletedAt: true,
        isPrivate: true,
      },
    });
    if (!channel || channel.type !== 'DIRECT') {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'DM channel not found');
    }
    const effective = await this.access.resolveEffective(channel, req.user.id);
    if ((effective & Permission.READ) !== Permission.READ) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_VISIBLE, 'not a participant of this DM');
    }
    req.channel = channel;
    req.dmChannelEffectiveMask = effective;
    return true;
  }
}
