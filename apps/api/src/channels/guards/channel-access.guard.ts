import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { ChannelAccessService } from '../permission/channel-access.service';
import { Permission } from '../../auth/permissions';

export const ALLOW_ARCHIVED_KEY = 'allowArchivedChannel';

/**
 * Loads `:id` (channel) into `req.channel`, scoped to the workspace already
 * validated by `WorkspaceMemberGuard`. A soft-deleted channel is hidden as
 * **404 CHANNEL_NOT_FOUND**. An archived channel is readable but the guard
 * flags it so mutating routes can reject.
 *
 * Mutating routes annotate themselves with `@AllowArchivedChannel()` (rare —
 * only `archive`/`unarchive`/`restore`/`delete`).
 */
@Injectable()
export class ChannelAccessGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ChannelAccessService) private readonly access: ChannelAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request & {
        params: Record<string, string>;
        workspace?: { id: string };
        channel?: unknown;
      }
    >();

    const channelId = req.params.chid ?? req.params.id;
    if (!channelId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'channel id path parameter missing');
    }
    const wsId = req.workspace?.id ?? req.params.id ?? req.params.wsId;
    if (!wsId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'workspace context missing in request');
    }

    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId: wsId },
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
    if (!channel || channel.deletedAt) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }

    // Task-014-A (task-012-follow-13): private-channel visibility uses
    // the shared ChannelAccessService so the effective-mask fold
    // (role base + overrides + DENY > ALLOW) matches what the
    // attachment / reaction / thread controllers see. Before 014 the
    // guard did a bare `allowMask > 0` count that drifted from
    // `PermissionMatrix.effective`.
    if (channel.isPrivate) {
      const user = (req as { user?: { id: string } }).user;
      // task-027 reviewer BLOCKER: previous code read `req.member`,
      // but WorkspaceMemberGuard assigns to `req.workspaceMember`.
      // The private-channel gate has been a silent no-op since
      // task-012; 027 is the first task to actually depend on it
      // firing (DM OWNER isolation).
      const member = (req as { workspaceMember?: { role: string } }).workspaceMember;
      // task-027-B: DIRECT channels are 1:1 and bypass the OWNER escape
      // hatch — only the two participants (explicit USER-level ALLOW
      // override) may access. OWNERs/ADMINs of the workspace are
      // blocked to preserve DM privacy.
      const isDirect = channel.type === 'DIRECT';
      if (user && member && (isDirect || member.role !== 'OWNER')) {
        const effective = await this.access.resolveEffective(channel, user.id);
        if ((effective & Permission.READ) !== Permission.READ) {
          throw new DomainError(ErrorCode.CHANNEL_NOT_VISIBLE, 'channel not visible to this user');
        }
      }
    }

    const allowArchived = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_ARCHIVED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (channel.archivedAt && !allowArchived) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived — unarchive first');
    }

    req.channel = channel;
    return true;
  }
}
