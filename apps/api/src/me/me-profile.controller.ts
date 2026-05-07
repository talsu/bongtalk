import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';

/**
 * task-046 iter5 (M1):
 *   GET   /me/profile           → { id, username, email, customStatus, bio }
 *   PATCH /me/profile  body: { bio?: string | null }
 *
 * bio:
 *   - 500 chars cap (app layer)
 *   - 빈 문자열 / null → 저장 시 null
 *   - markdown 허용 — 외부 URL 은 markdown link 형태로
 *
 * Rate limit: 10/min/user (UI 의 토글 + autosave 용 cap).
 *
 * 별도 endpoint 인 이유: status / dnd / bio 는 각자 cardinality 가
 * 다르고 PATCH 자주 일어나는 status 와 묶기엔 transactional context 가
 * 다름.
 */
const BIO_MAX_LENGTH = 500;

@Controller('me/profile')
export class MeProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<{
    id: string;
    username: string;
    email: string;
    customStatus: string | null;
    bio: string | null;
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        username: true,
        email: true,
        customStatus: true,
        bio: true,
      },
    });
    if (!row) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'profile not found');
    }
    return row;
  }

  @Patch()
  async patch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { bio?: string | null },
  ): Promise<{ bio: string | null }> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    const raw = body?.bio;
    let next: string | null;
    if (raw === null || raw === undefined) {
      next = null;
    } else if (typeof raw !== 'string') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'bio must be a string or null');
    } else {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        next = null;
      } else if (trimmed.length > BIO_MAX_LENGTH) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, `bio too long (max ${BIO_MAX_LENGTH})`);
      } else {
        next = trimmed;
      }
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { bio: next },
    });
    return { bio: next };
  }
}
