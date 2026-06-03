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

  /**
   * S62 fix-forward (security A-2 = HIGH-1 · FR-RM17): 첨부 업로드도 send/history 와
   * 동일하게 ADMINISTRATOR 채널 우회 감사 대상이다. ChannelAccessService 로 위임만
   * 한다(enforcement 불변 · best-effort 기록). requireUpload 직후 호출한다.
   */
  async auditAdministratorBypass(
    channel: { id: string; workspaceId: string | null },
    userId: string,
    action: string,
  ): Promise<void> {
    await this.access.auditAdministratorBypass(channel, userId, action);
  }
}
