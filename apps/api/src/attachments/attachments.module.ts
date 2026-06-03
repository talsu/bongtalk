import { forwardRef, Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ChannelAttachmentsController } from './channel-attachments.controller';
import { AttachmentProxyController } from './attachment-proxy.controller';
import { AttachmentUploadService } from './attachment-upload.service';
import { UploadRateLimitService } from './upload-rate-limit.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { AttachmentGcService } from './attachment-gc.service';
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
  controllers: [AttachmentsController, ChannelAttachmentsController, AttachmentProxyController],
  providers: [
    AttachmentsService,
    AttachmentUploadService,
    UploadRateLimitService,
    ChannelAccessByIdGuard,
    // S55 (FR-AM-29): orphan GC 도메인 서비스. QueueModule 의 AttachmentGcProcessor 가
    // 주입해 일일 sweep 을 실행한다(export 필요).
    AttachmentGcService,
  ],
  exports: [
    AttachmentsService,
    AttachmentUploadService,
    ChannelAccessByIdGuard,
    AttachmentGcService,
  ],
})
export class AttachmentsModule {}
