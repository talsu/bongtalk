import { Body, Controller, Put } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { EmojiPreferenceService, type UserEmojiPreferenceDto } from './emoji-preference.service';
import { UpdateEmojiPreferenceDto } from './dto/update-emoji-preference.dto';

/**
 * S42 (D05 / FR-PK03): PUT /me/emoji-preferences. me thin-controller 패턴
 * (me-profile 선례) — JwtAuthGuard 는 글로벌 APP_GUARD 라 별도 @UseGuards 불요.
 * upsert(userId unique). skinTone 1-6(422) / quickReactions ≤3·각 ≤64자 /
 * recentEmojis ≤36 검증은 서비스가 단일 출처로 수행한다. 200 + 전체 행.
 */
@Controller('me/emoji-preferences')
export class MeEmojiPreferenceController {
  constructor(
    private readonly prefs: EmojiPreferenceService,
    private readonly rate: RateLimitService,
  ) {}

  @Put()
  async put(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: UpdateEmojiPreferenceDto,
  ): Promise<UserEmojiPreferenceDto> {
    await this.rate.enforce([{ key: `me-emoji-prefs:u:${user.id}`, windowSec: 60, max: 20 }]);
    return this.prefs.updateUserPreference(user.id, {
      defaultSkinTone: body.defaultSkinTone,
      quickReactions: body.quickReactions,
      recentEmojis: body.recentEmojis,
    });
  }
}
