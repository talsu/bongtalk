import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  ChangeEmailRequestSchema,
  ChangePasswordRequestSchema,
  type ChangeEmailResponse,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { TokenService } from '../auth/services/token.service';
import { AccountSecurityService } from './account-security.service';

const REFRESH_COOKIE = 'refresh_token';

/**
 * S77b (D14 / FR-PS-15): 자격증명 변경(비밀번호·이메일).
 *
 *   POST /users/me/change-password  {currentPassword, newPassword}
 *   POST /users/me/change-email     {currentPassword, newEmail}
 *
 * 둘 다 JWT 필요 + 현재 비번 재확인. rate-limit: change-password 10/15m · change-email 5/15m.
 */
@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class AccountSecurityController {
  constructor(
    private readonly account: AccountSecurityService,
    private readonly tokens: TokenService,
    private readonly rate: RateLimitService,
  ) {}

  private async currentFamilyId(req: Request): Promise<string | null> {
    const raw = (req.cookies ?? {})[REFRESH_COOKIE];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return this.tokens.familyIdForRaw(raw);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    await this.rate.enforce([
      { key: `change-password:u:${user.id}`, windowSec: 900, max: 10 },
    ]);
    const parsed = ChangePasswordRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid change-password body (currentPassword/newPassword)',
      );
    }
    const familyId = await this.currentFamilyId(req);
    await this.account.changePassword(
      user.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      familyId,
    );
  }

  @Post('change-email')
  @HttpCode(200)
  async changeEmail(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<ChangeEmailResponse> {
    await this.rate.enforce([{ key: `change-email:u:${user.id}`, windowSec: 900, max: 5 }]);
    const parsed = ChangeEmailRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid change-email body (currentPassword/newEmail)',
      );
    }
    return this.account.changeEmail(user.id, parsed.data.currentPassword, parsed.data.newEmail);
  }
}
