import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { UnreadService, type UnreadWorkspaceTotal } from '../channels/unread.service';

/**
 * Task-018-E: `GET /me/unread-totals` — workspace-level unread aggregate
 * the server-rail uses to render per-workspace unread badges.
 *
 * One round-trip (single SQL aggregate). Per-workspace fanout stays
 * in the client via React Query caching. Returns an entry for every
 * workspace the caller is a member of, even when unreadCount is 0, so
 * the frontend doesn't have to cross-join workspaces with unread
 * totals on its own.
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeUnreadTotalsController {
  constructor(private readonly unread: UnreadService) {}

  @Get('unread-totals')
  async totals(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ totals: UnreadWorkspaceTotal[] }> {
    const totals = await this.unread.summarizeWorkspaceTotals(user.id);
    return { totals };
  }
}
