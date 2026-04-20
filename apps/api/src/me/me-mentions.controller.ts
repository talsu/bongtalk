import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { MeMentionsService } from './me-mentions.service';

/**
 * Task-011-B: `GET /me/mentions` returns a paginated list of recent
 * mentions + the unread count across the caller's channels. Auth'd
 * via the standard JWT guard; aggregates from jsonb-containment
 * queries over Message.mentions (GIN-indexed).
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeMentionsController {
  constructor(private readonly mentions: MeMentionsService) {}

  @Get('mentions')
  async index(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(20), new ParseIntPipe()) limit: number,
  ): Promise<{
    unreadCount: number;
    recent: Awaited<ReturnType<MeMentionsService['recent']>>;
  }> {
    const [unreadCount, recent] = await Promise.all([
      this.mentions.unreadCount(user.id),
      this.mentions.recent(user.id, limit),
    ]);
    return { unreadCount, recent };
  }
}
