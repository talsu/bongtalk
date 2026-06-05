import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { type AppearanceSettings, UpdateAppearanceSettingsSchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { AppearanceSettingsService } from './appearance-settings.service';

/**
 * S76 (D14 / FR-PS-09 + FR-PS-18): 외관 설정 API.
 *
 *   GET   /me/settings/appearance  → 현재 외관 설정(행 없으면 기본값 DARK/COZY/15/false).
 *   PATCH /me/settings/appearance  → 부분 자동 저장(upsert · create-if-not-exists).
 *
 * 알림 설정(/me/settings/notifications, S46)과는 별도 URL 이다. 인증은 JwtAuthGuard,
 * 비즈 규칙(6단계 폰트·기본값·행 생성)은 AppearanceSettingsService 가 단일 출처로 보유.
 * Rate limit: GET 60/min/user · PATCH 30/min/user(자동 저장이 잦아 PATCH 를 좀 더 빡빡하게).
 */
@UseGuards(JwtAuthGuard)
@Controller('me/settings/appearance')
export class AppearanceSettingsController {
  constructor(
    private readonly appearance: AppearanceSettingsService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<AppearanceSettings> {
    await this.rate.enforce([{ key: `me-appearance-get:u:${user.id}`, windowSec: 60, max: 60 }]);
    return this.appearance.getAppearance(user.id);
  }

  @Patch()
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<AppearanceSettings> {
    await this.rate.enforce([{ key: `me-appearance-patch:u:${user.id}`, windowSec: 60, max: 30 }]);
    const parsed = UpdateAppearanceSettingsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid appearance body (theme/density/chatFontSize/clock24h)',
      );
    }
    return this.appearance.updateAppearance(user.id, parsed.data);
  }
}
