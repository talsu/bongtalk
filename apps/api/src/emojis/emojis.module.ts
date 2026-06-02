import { Module } from '@nestjs/common';
import { CustomEmojiController } from './custom-emoji.controller';
import { CustomEmojiService } from './custom-emoji.service';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';

/**
 * task-037-D / S41 (D05): workspace custom-emoji module. AuthModule is
 * imported for RateLimitService; StorageModule provides the S3Service used
 * for the presigned PUT/GET calls and the delete on teardown. S41:
 * OutboxService(전역 OutboxModule 제공)로 finalize/delete 가 emoji.created /
 * emoji.deleted 이벤트를 기록해 워크스페이스 룸 fanout 한다(FR-RC20).
 */
@Module({
  imports: [StorageModule, AuthModule],
  controllers: [CustomEmojiController],
  providers: [CustomEmojiService],
  exports: [CustomEmojiService],
})
export class EmojisModule {}
