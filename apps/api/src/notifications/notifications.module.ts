import { Module } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
// S46 (D06 / FR-MN-05/06/07/08): NotifLevel 3계층 알림 설정.
import { NotifPreferencesService } from './notif-preferences.service';
import { NotifLevelService } from './notif-level.service';
import { MuteExpiryCron } from './mute-expiry.cron';
import { GlobalNotificationSettingsController } from './global-notification-settings.controller';
import { ServerNotificationPreferencesController } from './server-notification-preferences.controller';
// F-S1 (security MED): GlobalNotificationSettingsController 의 GET/PATCH rate-limit 강제용.
import { AuthModule } from '../auth/auth.module';

@Module({
  // F-S1: RateLimitService 를 export 하는 AuthModule 을 import 해 컨트롤러에 주입한다.
  imports: [AuthModule],
  controllers: [
    NotificationPreferencesController,
    // S46: 글로벌(/me/settings/notifications) + 서버(/workspaces/:id/notification-preferences).
    // 채널 컨트롤러는 ChannelAccessGuard 가 필요해 ChannelsModule 에 둔다(NotifPreferencesService
    // 를 import 로 재사용).
    GlobalNotificationSettingsController,
    ServerNotificationPreferencesController,
  ],
  providers: [
    NotificationPreferencesService,
    NotifPreferencesService,
    NotifLevelService,
    MuteExpiryCron,
  ],
  exports: [
    NotificationPreferencesService,
    // S46: 멘션 fanout(MessagesModule)·채널 컨트롤러(ChannelsModule)가 소비.
    NotifPreferencesService,
    NotifLevelService,
  ],
})
export class NotificationsModule {}
