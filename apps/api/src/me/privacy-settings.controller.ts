import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { type PrivacySettings, UpdatePrivacySettingsSchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrivacySettingsService } from './privacy-settings.service';

/**
 * S77a (D14 / FR-PS-13): 프라이버시 설정 API. S76 AppearanceSettingsController 패턴을 mirror.
 *
 *   GET   /me/settings/privacy  → 현재 프라이버시 설정(행 없으면 기본값 true/true/EVERYONE).
 *   PATCH /me/settings/privacy  → 부분 자동 저장(upsert · create-if-not-exists).
 *
 * 인증은 JwtAuthGuard, 비즈 규칙은 PrivacySettingsService 가 단일 출처로 보유한다. 저장된
 * 값은 DM/친구요청 도메인 게이트가 읽어 enforce 한다(죽은 컨트롤 금지 — service 주석 참조).
 * Rate limit(S76 fix-forward 와 동일): GET 60/min · PATCH 30/min.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/settings/privacy')
export class PrivacySettingsController {
  constructor(
    private readonly privacy: PrivacySettingsService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<PrivacySettings> {
    await this.rate.enforce([{ key: `me-privacy-get:u:${user.id}`, windowSec: 60, max: 60 }]);
    return this.privacy.getPrivacy(user.id);
  }

  @Patch()
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<PrivacySettings> {
    await this.rate.enforce([{ key: `me-privacy-patch:u:${user.id}`, windowSec: 60, max: 30 }]);
    const parsed = UpdatePrivacySettingsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid privacy body (allowDmFromWorkspaceMembers/messageRequestEnabled/allowFriendRequests)',
      );
    }
    return this.privacy.updatePrivacy(user.id, parsed.data);
  }
}
