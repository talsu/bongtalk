import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { OutboxModule } from '../common/outbox/outbox.module';
import { MessagesModule } from '../messages/messages.module';
import { ReactionsController } from './reactions.controller';
import { ReactionsService } from './reactions.service';

@Module({
  // S39 (FR-RE04): GET reactions 가 MessagesService.aggregateReactionDetails 를
  // 재사용하므로 MessagesModule 을 import 한다(MessagesModule 은 ReactionsModule 을
  // import 하지 않아 순환 없음).
  // S63 fix-forward (perf C-1): 타임아웃 게이트가 canAddReaction 의 멤버 findUnique 에
  // mutedUntil 을 편승하도록 바뀌어 ModerationService 의존이 제거됐다(WorkspacesModule
  // import 불요 — 별도 isTimedOut DB 왕복도 함께 사라졌다).
  imports: [AuthModule, AttachmentsModule, OutboxModule, MessagesModule],
  controllers: [ReactionsController],
  providers: [ReactionsService],
  exports: [ReactionsService],
})
export class ReactionsModule {}
