import { Controller, Get, Query } from '@nestjs/common';
import { LinksService } from './links.service';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

const URL_MAX_LEN = 2048;

function validatePreviewUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'url query parameter required');
  }
  if (raw.length > URL_MAX_LEN) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, `url too long (max ${URL_MAX_LEN})`);
  }
  try {
    new URL(raw);
  } catch {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid url');
  }
  return raw;
}

/**
 * task-045 iter2: GET /links/preview?url=...
 *
 * 인증 필수 — JwtAuthGuard 는 APP_GUARD 로 global 등록되어 있어 별도
 * @UseGuards 불필요. @Public 미부여이므로 자동으로 토큰 요구.
 *
 * Per-user rate limit 60/min: 빠른 타이핑 조차도 충분.
 *
 * 반환은 항상 200 + LinkPreview 형태 (statusCode 필드로 upstream 의
 * 응답 코드 구분). 4xx 던지는 경우는 SSRF guard 가 reject 했을 때만.
 */
@Controller('links')
export class LinksController {
  constructor(
    private readonly links: LinksService,
    private readonly rate: RateLimitService,
  ) {}

  @Get('preview')
  async preview(@CurrentUser() user: CurrentUserPayload, @Query() query: Record<string, unknown>) {
    const url = validatePreviewUrl(query.url);
    await this.rate.enforce([{ key: `links:preview:u:${user.id}`, windowSec: 60, max: 60 }]);
    return this.links.getPreview(url);
  }
}
