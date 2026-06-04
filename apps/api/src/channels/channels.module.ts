import { forwardRef, Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ChannelReadController, UnreadSummaryController } from './unread.controller';
import { UnreadService } from './unread.service';
import { ChannelAccessService } from './permission/channel-access.service';
import { ChannelAccessGuard } from './guards/channel-access.guard';
import { SlowmodeService } from './slowmode/slowmode.service';
// task-037-A: DirectMessagesController removed (027 workspace-scoped DM
// endpoints). GlobalDmController at /me/dms is the sole DM surface.
import { DirectMessagesService } from './direct-messages/direct-messages.service';
import { GlobalDmController } from './direct-messages/global-dm.controller';
// S43 (FR-CH-15): 채널 즐겨찾기 — 워크스페이스 스코프 + /me/favorites.
import { FavoritesService } from './favorites/favorites.service';
import { FavoritesController, MeFavoritesController } from './favorites/favorites.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { OutboxModule } from '../common/outbox/outbox.module';
import { MessagesModule } from '../messages/messages.module';
// S62 fix-forward (security A-3): override CRUD rate-limit 용 RateLimitService.
// AuthModule 은 도메인 모듈을 import 하지 않는 leaf 라 순환이 없다.
import { AuthModule } from '../auth/auth.module';
// S20 (FR-DM-06): DirectMessagesService 의 그룹 DM 아이콘 업로드용 S3Service.
import { StorageModule } from '../storage/storage.module';
// S20 (FR-DM-11): GlobalDmController 의 DM 뮤트 라우트가 기존 MutesService 재사용.
import { MutesModule } from '../notifications/mutes/mutes.module';
// S46 (D06 / FR-MN-07): 채널 단위 알림 오버라이드 — ChannelAccessGuard 가 필요해
// 이 모듈에 컨트롤러를 두고, 설정 서비스는 NotificationsModule 에서 재사용한다.
// NotificationsModule 은 도메인 모듈을 import 하지 않아 순환이 없다.
import { NotificationsModule } from '../notifications/notifications.module';
import { ChannelNotificationPreferencesController } from '../notifications/channel-notification-preferences.controller';

@Module({
  // S13 (FR-CH-09/04): ChannelsService → MessagesService.createSystemMessage
  // 역참조용 forwardRef. MessagesModule 도 ChannelsModule 을 forwardRef 로
  // 가져오므로 양방향 순환이 끊긴다.
  imports: [
    // S64 fix-forward (security A-1/A-2): WorkspacesModule(ModerationReportService)이
    // ChannelAccessService 를 주입하려고 ChannelsModule 을 forwardRef 로 가져오므로,
    // 이 import 도 forwardRef 로 바꿔 양방향 순환을 끊는다.
    forwardRef(() => WorkspacesModule),
    OutboxModule,
    forwardRef(() => MessagesModule),
    StorageModule,
    MutesModule,
    NotificationsModule,
    AuthModule,
  ],
  controllers: [
    ChannelsController,
    CategoriesController,
    UnreadSummaryController,
    ChannelReadController,
    GlobalDmController,
    FavoritesController,
    MeFavoritesController,
    // S46 (FR-MN-07): 채널 단위 알림 오버라이드.
    ChannelNotificationPreferencesController,
  ],
  // Task-014-A: ChannelAccessService is the single source of truth for
  // channel ACL checks (private-channel visibility, permission-bit
  // gating). Both ChannelAccessGuard (URL-path) and ChannelAccessByIdGuard
  // (body-param) now consume it; export so downstream modules like
  // attachments / reactions / threads can wire the by-id guard.
  providers: [
    ChannelsService,
    CategoriesService,
    UnreadService,
    ChannelAccessService,
    ChannelAccessGuard,
    DirectMessagesService,
    // S15 (FR-CH-08): 슬로우모드 게이트. MessagesController 가 송신 경로에서 소비.
    SlowmodeService,
    // S43 (FR-CH-15): 채널 즐겨찾기 CRUD + 재정렬.
    FavoritesService,
  ],
  exports: [
    ChannelsService,
    CategoriesService,
    UnreadService,
    ChannelAccessService,
    ChannelAccessGuard,
    DirectMessagesService,
    SlowmodeService,
  ],
})
export class ChannelsModule {}
