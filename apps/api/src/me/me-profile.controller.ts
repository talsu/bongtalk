import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';

/**
 * task-046 iter5 (M1) + task-047 iter3 (M2):
 *   GET   /me/profile           → { id, username, email, customStatus, bio, links }
 *   PATCH /me/profile  body: { bio?: string | null, links?: ProfileLink[] | null }
 *
 * bio:
 *   - 500 chars cap (app layer)
 *   - 빈 문자열 / null → 저장 시 null
 *   - markdown 허용 — 외부 URL 은 markdown link 형태로
 *
 * links (M2 carry-over from 046 iter5):
 *   - Array<{ url: string, label?: string }>, cap 3
 *   - 각 url 은 https?:// 만, 2048 chars cap
 *   - label 은 32 chars cap, optional
 *   - null → no links
 *
 * Rate limit: 10/min/user (UI 의 토글 + autosave 용 cap).
 */
const BIO_MAX_LENGTH = 500;
const LINKS_MAX = 3;
const LINK_URL_MAX = 2048;
const LINK_LABEL_MAX = 32;

interface ProfileLink {
  url: string;
  label?: string;
}

function validateLinks(raw: unknown): ProfileLink[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'links must be an array or null');
  }
  if (raw.length === 0) return null;
  if (raw.length > LINKS_MAX) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, `too many links (max ${LINKS_MAX})`);
  }
  const validated: ProfileLink[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'each link must be an object');
    }
    const r = e as { url?: unknown; label?: unknown };
    if (typeof r.url !== 'string' || r.url.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'link.url must be a non-empty string');
    }
    if (r.url.length > LINK_URL_MAX) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, `link.url too long (max ${LINK_URL_MAX})`);
    }
    if (!/^https?:\/\//i.test(r.url)) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'link.url must start with http:// or https://',
      );
    }
    let label: string | undefined;
    if (r.label !== undefined && r.label !== null) {
      if (typeof r.label !== 'string') {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'link.label must be a string');
      }
      const trimmed = r.label.trim();
      if (trimmed.length > LINK_LABEL_MAX) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          `link.label too long (max ${LINK_LABEL_MAX})`,
        );
      }
      if (trimmed.length > 0) label = trimmed;
    }
    validated.push(label ? { url: r.url, label } : { url: r.url });
  }
  return validated;
}

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
    links: ProfileLink[] | null;
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        username: true,
        email: true,
        customStatus: true,
        bio: true,
        links: true,
      },
    });
    if (!row) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'profile not found');
    }
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      customStatus: row.customStatus,
      bio: row.bio,
      links: (row.links as ProfileLink[] | null) ?? null,
    };
  }

  @Patch()
  async patch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { bio?: string | null; links?: unknown },
  ): Promise<{ bio: string | null; links: ProfileLink[] | null }> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    const data: { bio?: string | null; links?: unknown } = {};

    // bio (M1)
    if ('bio' in body) {
      const raw = body.bio;
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
          throw new DomainError(
            ErrorCode.VALIDATION_FAILED,
            `bio too long (max ${BIO_MAX_LENGTH})`,
          );
        } else {
          next = trimmed;
        }
      }
      data.bio = next;
    }

    // task-047 iter3 (M2): links — Prisma JSON Null 처리
    const updateData: Prisma.UserUpdateInput = {};
    let nextBio: string | null | undefined;
    let nextLinks: ProfileLink[] | null | undefined;
    if ('bio' in data) {
      nextBio = data.bio as string | null;
      updateData.bio = nextBio;
    }
    if ('links' in body) {
      nextLinks = validateLinks(body.links);
      updateData.links =
        nextLinks === null ? Prisma.JsonNull : (nextLinks as unknown as Prisma.InputJsonValue);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });
    // 응답은 본 patch 의 입력 기준 (request → DB 일관성). bio/links 가
    // 명시되지 않으면 null 반환 — partial update 시 미명시 필드는 변경
    // 안 됨이지만 응답 schema 단순화를 위해 null 표기.
    return {
      bio: nextBio !== undefined ? nextBio : null,
      links: nextLinks !== undefined ? nextLinks : null,
    };
  }
}
