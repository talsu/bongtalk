import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  TotpDisableRequestSchema,
  TotpVerifyRequestSchema,
  type TotpSetupResponse,
  type TotpVerifyResponse,
  type TwoFactorStatus,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PasswordService } from '../auth/services/password.service';
import { PrismaService } from '../prisma/prisma.module';
import { TwoFactorService } from '../auth/services/two-factor.service';

/**
 * S77b (D14 / FR-PS-15·20): TOTP 2FA 엔드포인트.
 *
 *   GET    /me/2fa             → {totpEnabled}
 *   POST   /me/2fa/totp/setup  → {otpauthUri, secret, qrDataUri} + Cache-Control: no-store (FR-PS-20)
 *   POST   /me/2fa/totp/verify {code} → {totpEnabled, backupCodes(10)}
 *   DELETE /me/2fa/totp        {currentPassword, totpCode} → 204
 *
 * rate-limit: setup/verify 5/min · disable 3/min. 키 미설정 시 모든 처리가 503
 * ENCRYPTION_UNAVAILABLE(TwoFactorService 가 선행 게이트 — 크래시 금지).
 */
@UseGuards(JwtAuthGuard)
@Controller('me/2fa')
export class TwoFactorController {
  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly passwords: PasswordService,
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async status(@CurrentUser() user: CurrentUserPayload): Promise<TwoFactorStatus> {
    return this.twoFactor.getStatus(user.id);
  }

  @Post('totp/setup')
  @HttpCode(200)
  async setup(
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpSetupResponse> {
    await this.rate.enforce([{ key: `totp-setup:u:${user.id}`, windowSec: 60, max: 5 }]);
    // FR-PS-20: 시크릿/otpauth/QR 가 캐시·프록시에 남지 않도록 no-store 를 강제한다.
    res.setHeader('Cache-Control', 'no-store');
    return this.twoFactor.setup(user.id, user.email);
  }

  @Post('totp/verify')
  @HttpCode(200)
  async verify(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpVerifyResponse> {
    await this.rate.enforce([{ key: `totp-verify:u:${user.id}`, windowSec: 60, max: 5 }]);
    const parsed = TotpVerifyRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid TOTP verify body (code)');
    }
    // 백업코드(평문)가 캐시에 남지 않도록 verify 응답도 no-store.
    res.setHeader('Cache-Control', 'no-store');
    return this.twoFactor.verify(user.id, parsed.data.code);
  }

  @Delete('totp')
  @HttpCode(204)
  async disable(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown): Promise<void> {
    await this.rate.enforce([{ key: `totp-disable:u:${user.id}`, windowSec: 60, max: 3 }]);
    const parsed = TotpDisableRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid TOTP disable body (currentPassword/totpCode)',
      );
    }
    // 비번 + TOTP 코드 동시 필수 — 코드 누락은 403 TOTP_CODE_REQUIRED(비번 단독 해제 차단).
    if (!parsed.data.totpCode) {
      throw new DomainError(
        ErrorCode.TOTP_CODE_REQUIRED,
        'a valid TOTP code is required to disable 2FA',
      );
    }
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!dbUser) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'user not found');
    }
    const ok = await this.passwords.verify(dbUser.passwordHash, parsed.data.currentPassword);
    if (!ok) {
      throw new DomainError(ErrorCode.PASSWORD_INCORRECT, 'current password is incorrect');
    }
    await this.twoFactor.disable(user.id, parsed.data.totpCode);
  }
}
