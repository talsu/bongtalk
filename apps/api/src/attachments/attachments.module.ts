import { forwardRef, Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  // task-014-A: ChannelsModule exports the shared ChannelAccessService
  // that ChannelAccessByIdGuard now delegates to.
  // S13: ChannelsModule ↔ MessagesModule ↔ AttachmentsModule 3-모듈 순환이
  // 생겼다(ChannelsService → createSystemMessage 역참조). 이 back-edge 도
  // forwardRef 로 지연 해석해 모듈 초기화 시 undefined 참조를 피한다.
  imports: [StorageModule, forwardRef(() => ChannelsModule)],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, ChannelAccessByIdGuard],
  exports: [AttachmentsService, ChannelAccessByIdGuard],
})
export class AttachmentsModule {}
