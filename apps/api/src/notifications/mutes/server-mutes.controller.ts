import { Controller, Get } from '@nestjs/common';
import { MutesService } from './mutes.service';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';

/**
 * S49 (D06 / FR-MN-17): "현재 뮤트 중" 서버(워크스페이스) 목록 API.
 *
 *   GET /me/server-mutes → 활성 서버 뮤트(ServerNotificationPref isMuted=true,
 *     muteUntil null=영구 | muteUntil>now)만 Workspace join 해 반환.
 *
 * 권한: 본인 설정만 — 전역 JwtAuthGuard 가 인증을 강제하고, userId 는 토큰에서
 * 가져온다(CurrentUser). 해제는 신규 API 없이 기존 DELETE /workspaces/:id/
 * notification-preferences(서버 뮤트 해제)를 재사용한다.
 *
 * 채널 뮤트 목록(GET /me/mutes)과 base path 가 달라(`me/mutes` vs `me/server-mutes`)
 * 별도 컨트롤러로 둔다 — PRD 정본 경로(`/me/server-mutes`)를 그대로 따른다.
 */
@Controller('me/server-mutes')
export class ServerMutesController {
  constructor(private readonly mutes: MutesService) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload) {
    const items = await this.mutes.listActiveServerMutes(user.id);
    return {
      items: items.map((r) => ({
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        workspaceIconUrl: r.workspaceIconUrl,
        muteUntil: r.muteUntil ? r.muteUntil.toISOString() : null,
        level: r.level,
      })),
    };
  }
}
