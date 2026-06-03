import { forwardRef, Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ChannelAttachmentsController } from './channel-attachments.controller';
import { AttachmentUploadService } from './attachment-upload.service';
import { UploadRateLimitService } from './upload-rate-limit.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  // task-014-A: ChannelsModule exports the shared ChannelAccessService
  // that ChannelAccessByIdGuard now delegates to.
  // S13: ChannelsModule ↔ MessagesModule ↔ AttachmentsModule 3-모듈 순환이
  // 생겼다(ChannelsService → createSystemMessage 역참조). 이 back-edge 도
  // forwardRef 로 지연 해석해 모듈 초기화 시 undefined 참조를 피한다.
  // S54 (D11): RedisModule 은 @Global 이라 UploadRateLimitService 의 REDIS 주입에
  // 별도 import 불요.
  imports: [StorageModule, forwardRef(() => ChannelsModule)],
  controllers: [AttachmentsController, ChannelAttachmentsController],
  providers: [
    AttachmentsService,
    AttachmentUploadService,
    UploadRateLimitService,
    ChannelAccessByIdGuard,
  ],
  exports: [AttachmentsService, AttachmentUploadService, ChannelAccessByIdGuard],
})
export class AttachmentsModule {}
