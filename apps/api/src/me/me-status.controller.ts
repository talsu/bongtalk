import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';

/**
 * task-045 iter4: 자유 문자열 custom status text — Discord parity.
 *
 *   GET   /me/profile/status            → { customStatus: string | null }
 *   PATCH /me/profile/status { text: string | null }
 *
 * - 본인의 status 만 갱신 가능. presence enum (auto/dnd) 와 무관.
 * - text null 또는 빈 문자열 → null 저장 (clear).
 * - max 100 chars (Discord 의 128 보다 보수적).
 * - WS broadcast 통합은 follow-up — 이번 iter 는 GET /me/profile 등에서
 *   읽히기만 하면 충분.
 *
 * Rate limit: 60/min — 사람이 status 토글하는 것보다 충분히 큽니다.
 *
 * 인증: JwtAuthGuard 가 APP_GUARD 로 글로벌 — @Public 미부여로 자동 적용.
 */
const CUSTOM_STATUS_MAX_LENGTH = 100;

@Controller('me/profile/status')
export class MeStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<{ customStatus: string | null }> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { customStatus: true },
    });
    return { customStatus: row?.customStatus ?? null };
  }

  @Patch()
  async set(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { text?: string | null },
  ): Promise<{ customStatus: string | null }> {
    await this.rate.enforce([{ key: `me-status:u:${user.id}`, windowSec: 60, max: 60 }]);
    const raw = body?.text;
    let next: string | null;
    if (raw === null || raw === undefined || raw === '') {
      next = null;
    } else if (typeof raw !== 'string') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'text must be a string or null');
    } else {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        next = null;
      } else if (trimmed.length > CUSTOM_STATUS_MAX_LENGTH) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          `text too long (max ${CUSTOM_STATUS_MAX_LENGTH})`,
        );
      } else {
        next = trimmed;
      }
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { customStatus: next },
    });
    return { customStatus: next };
  }
}
