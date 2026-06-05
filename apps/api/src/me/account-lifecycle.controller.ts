import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  DeactivateAccountRequestSchema,
  ReactivateAccountRequestSchema,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { AccountLifecycleService } from './account-lifecycle.service';

/**
 * S77c (D14 / FR-PS-16): 계정 비활성화 / 재활성화.
 *
 *   POST /api/v1/users/me/deactivate  {currentPassword, totpCode?} → 204  (JWT 필요)
 *   POST /api/v1/users/me/reactivate  {email, password, totpCode?} → 204  (공개 — 비활성 계정은
 *     로그인 차단되므로 인증 컨텍스트 없이 자격증명으로 직접 복구)
 *
 * rate-limit: deactivate 3/h · reactivate 3/h.
 */
@Controller('users/me')
export class AccountLifecycleController {
  constructor(
    private readonly lifecycle: AccountLifecycleService,
    private readonly rate: RateLimitService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('deactivate')
  @HttpCode(204)
  async deactivate(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown): Promise<void> {
    await this.rate.enforce([{ key: `deactivate:u:${user.id}`, windowSec: 3600, max: 3 }]);
    const parsed = DeactivateAccountRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid deactivate body (currentPassword/totpCode)',
      );
    }
    await this.lifecycle.deactivate(user.id, parsed.data.currentPassword, parsed.data.totpCode);
  }

  // 공개 라우트: 비활성 계정은 JWT 가드가 ACCOUNT_DEACTIVATED 로 막으므로 reactivate 만은
  // 인증 없이 자격증명으로 진입한다. rate-limit 은 email 스코프(자격증명 기준)로 집행한다.
  @Public()
  @Post('reactivate')
  @HttpCode(204)
  async reactivate(@Body() body: unknown): Promise<void> {
    const parsed = ReactivateAccountRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid reactivate body (email/password/totpCode)',
      );
    }
    await this.rate.enforce([
      { key: `reactivate:e:${parsed.data.email.toLowerCase()}`, windowSec: 3600, max: 3 },
    ]);
    await this.lifecycle.reactivate(parsed.data.email, parsed.data.password, parsed.data.totpCode);
  }
}
