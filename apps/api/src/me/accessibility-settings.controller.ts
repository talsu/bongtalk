import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { type AccessibilitySettings, UpdateAccessibilitySettingsSchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { AccessibilitySettingsService } from './accessibility-settings.service';

/**
 * S77a (D14 / FR-PS-12): 접근성 설정 API. S76 AppearanceSettingsController 패턴을 mirror.
 *
 *   GET   /me/settings/accessibility  → 현재 접근성 설정(행 없으면 기본값 false/false).
 *   PATCH /me/settings/accessibility  → 부분 자동 저장(upsert · create-if-not-exists).
 *
 * 인증은 JwtAuthGuard, 비즈 규칙은 AccessibilitySettingsService 가 단일 출처로 보유한다.
 * Rate limit(S76 fix-forward 와 동일 — notif 처럼 누락하지 않는다): GET 60/min · PATCH 30/min.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/settings/accessibility')
export class AccessibilitySettingsController {
  constructor(
    private readonly accessibility: AccessibilitySettingsService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<AccessibilitySettings> {
    await this.rate.enforce([{ key: `me-a11y-get:u:${user.id}`, windowSec: 60, max: 60 }]);
    return this.accessibility.getAccessibility(user.id);
  }

  @Patch()
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<AccessibilitySettings> {
    await this.rate.enforce([{ key: `me-a11y-patch:u:${user.id}`, windowSec: 60, max: 30 }]);
    const parsed = UpdateAccessibilitySettingsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid accessibility body (reduceMotion/highContrast)',
      );
    }
    return this.accessibility.updateAccessibility(user.id, parsed.data);
  }
}
