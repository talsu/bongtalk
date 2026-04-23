import { Injectable } from '@nestjs/common';
import { ChannelAccessService } from '../../channels/permission/channel-access.service';
import { Permission } from '../../auth/permissions';

/**
 * Thin adapter over `ChannelAccessService`. Kept as its own class +
 * name so the attachment / reaction controllers keep their public
 * API — the heavy lifting (override lookup, mask fold) moved into
 * the shared service in task-014-A (task-012-follow-13 closure) so
 * the two channel-access entry points don't diverge.
 *
 * Not a NestJS `CanActivate` guard because the channel id for
 * attachment routes comes from the request body / pre-resolved
 * object, not a URL path, so the route-level guard pattern doesn't
 * fit. A service-level injectable keeps the API the same
 * (`await guard.requireX(channel, userId)`).
 */
@Injectable()
export class ChannelAccessByIdGuard {
  constructor(private readonly access: ChannelAccessService) {}

  async requireRead(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    await this.access.requirePermission(channel, userId, Permission.READ);
  }

  async requireUpload(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    await this.access.requirePermission(channel, userId, Permission.UPLOAD_ATTACHMENT);
  }
}
