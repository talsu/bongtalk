import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import {
  MeNotificationBadgesService,
  type NotificationBadge,
} from './me-notification-badges.service';

/**
 * S47 (D06 / FR-MN-14 / FR-MN-20): `GET /me/notification-badges`.
 *
 * 서버(워크스페이스) 단위 알림 배지 데이터를 반환한다. 클라이언트는 연결 복구
 * (reconnect) 또는 탭 포커스 복귀(visibilitychange) 시 1회 호출해 낙관적 카운트를
 * 서버 진실값으로 재동기화한다(30초 polling 미사용 — FR-MN-20). isMuted 채널/서버는
 * 카운트에서 제외된다(서비스 게이트). `/me/unread-totals` 와 역할이 다르다(그쪽은
 * 사이드바 읽지 않음 레일, 뮤트 무관).
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeNotificationBadgesController {
  constructor(private readonly svc: MeNotificationBadgesService) {}

  @Get('notification-badges')
  async badges(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ workspaces: NotificationBadge[] }> {
    const workspaces = await this.svc.badges(user.id);
    return { workspaces };
  }
}
