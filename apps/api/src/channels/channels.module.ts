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
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { OutboxModule } from '../common/outbox/outbox.module';
import { MessagesModule } from '../messages/messages.module';

@Module({
  // S13 (FR-CH-09/04): ChannelsService → MessagesService.createSystemMessage
  // 역참조용 forwardRef. MessagesModule 도 ChannelsModule 을 forwardRef 로
  // 가져오므로 양방향 순환이 끊긴다.
  imports: [WorkspacesModule, OutboxModule, forwardRef(() => MessagesModule)],
  controllers: [
    ChannelsController,
    CategoriesController,
    UnreadSummaryController,
    ChannelReadController,
    GlobalDmController,
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
