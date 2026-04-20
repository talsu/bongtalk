import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { FeedbackCategory } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { FeedbackService } from './feedback.service';

const CATEGORIES: ReadonlySet<string> = new Set(['BUG', 'FEATURE', 'OTHER']);

/**
 * Task-016-C-3: POST /feedback. Auth required (no anonymous
 * feedback — we tie it to a user id so `GDPR export / delete` covers
 * the row). Rate limit 5/hour/user to block accidental double-submit
 * + scripted abuse; the closed-beta gate already keeps scale
 * manageable so a tighter cap wasn't needed.
 *
 * `page` comes from the Referer header (client passes a whitelisted
 * app URL), `userAgent` from the UA header. Neither is trusted for
 * security decisions — both land in the feedback row for operator
 * triage context.
 *
 * NEVER log `content` — user text may carry PII. The request-log
 * interceptor redacts the body for this path; this controller itself
 * only logs the row id on success.
 */
@UseGuards(JwtAuthGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly rate: RateLimitService,
  ) {}

  @Post()
  async submit(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { category?: string; content?: string; workspaceId?: string | null },
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
  ) {
    await this.rate.enforce([{ key: `feedback:u:${user.id}`, windowSec: 3600, max: 5 }]);
    if (!body || typeof body.content !== 'string') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'content is required');
    }
    const categoryRaw = (body.category ?? 'OTHER').toUpperCase();
    if (!CATEGORIES.has(categoryRaw)) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'category must be BUG|FEATURE|OTHER');
    }
    const category = categoryRaw as FeedbackCategory;
    const page = typeof req.headers.referer === 'string' ? req.headers.referer.slice(0, 500) : null;
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, 500) : null;
    const { id, createdAt } = await this.feedback.submit({
      userId: user.id,
      workspaceId:
        typeof body.workspaceId === 'string' && body.workspaceId.length > 0
          ? body.workspaceId
          : null,
      category,
      content: body.content,
      page,
      userAgent: ua,
    });
    return { id, createdAt };
  }
}
