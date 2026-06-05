import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
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
  // 인증 없이 자격증명으로 진입한다. rate-limit 은 IP + email 이중 스코프로 집행한다(CF4).
  @Public()
  @Post('reactivate')
  @HttpCode(204)
  async reactivate(@Req() req: Request, @Body() body: unknown): Promise<void> {
    const parsed = ReactivateAccountRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid reactivate body (email/password/totpCode)',
      );
    }
    // CF4 fix-forward (reviewer M2 · security HIGH): @Public reactivate 가 email 스코프(3/h)만 막아
    // 분산 brute-force / 계정 열거에 취약했다. login 의 clientIp() 관례로 IP 버킷(10/15m)을 email
    // 버킷 앞에 추가한다(IP 가 먼저 새도록 — IP 초과 시 email 버킷 토큰을 소모하지 않는다).
    await this.rate.enforce([
      { key: `reactivate:ip:${clientIp(req)}`, windowSec: 900, max: 10 },
      { key: `reactivate:e:${parsed.data.email.toLowerCase()}`, windowSec: 3600, max: 3 },
    ]);
    await this.lifecycle.reactivate(parsed.data.email, parsed.data.password, parsed.data.totpCode);
  }
}

// S66 fix-forward(review HIGH-2) / auth.controller.clientIp 관례와 동일: nginx 프록시 뒤라
// X-Forwarded-For 의 첫 홉(원 클라이언트)을 우선하고, 없으면 Express req.ip 로 폴백한다.
// 미상이면 'unknown' 단일 버킷으로 묶는다. (auth.controller 의 private 메서드를 재export 하지 않고
// 동일 로직을 모듈-로컬 헬퍼로 둔다 — 두 컨트롤러가 import 순환 없이 같은 관례를 공유.)
function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    const first = fwd[0]?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? 'unknown';
}
