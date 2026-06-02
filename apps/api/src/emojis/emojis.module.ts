import { Module } from '@nestjs/common';
import { CustomEmojiController, WorkspaceEmojiSettingsController } from './custom-emoji.controller';
import { CustomEmojiService } from './custom-emoji.service';
import { EmojiPreferenceService } from './emoji-preference.service';
import { MeEmojiPreferenceController } from './me-emoji-preference.controller';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';

/**
 * task-037-D / S41 / S42 (D05): workspace custom-emoji module. AuthModule is
 * imported for RateLimitService; StorageModule provides the S3Service used
 * for the presigned PUT/GET calls and the delete on teardown. S41:
 * OutboxService(전역 OutboxModule 제공)로 finalize/delete/alias 가 emoji.created /
 * emoji.deleted / emoji.alias_updated 이벤트를 기록해 워크스페이스 룸 fanout 한다.
 * S42: 별칭 CRUD + 사용자 선호(PUT /me/emoji-preferences) + 워크스페이스 설정 +
 * 피커 데이터(FR-EM05/PK01/PK03/PK04). MeEmojiPreferenceController 는 me thin-controller
 * 패턴(JwtAuthGuard 는 글로벌 가드)이다.
 */
@Module({
  imports: [StorageModule, AuthModule],
  controllers: [
    CustomEmojiController,
    WorkspaceEmojiSettingsController,
    MeEmojiPreferenceController,
  ],
  providers: [CustomEmojiService, EmojiPreferenceService],
  exports: [CustomEmojiService, EmojiPreferenceService],
})
export class EmojisModule {}
