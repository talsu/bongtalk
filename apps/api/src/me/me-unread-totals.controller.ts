import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { UnreadService, type UnreadWorkspaceTotal } from '../channels/unread.service';

/**
 * Task-018-E: `GET /me/unread-totals` — workspace-level unread aggregate
 * the server-rail uses to render per-workspace unread badges.
 *
 * Returns an entry for every workspace the caller is a member of, even when
 * unreadCount is 0, so the frontend doesn't have to cross-join workspaces with
 * unread totals on its own.
 *
 * S21 fix-forward (MAJOR-A): 종전엔 `summarizeWorkspaceTotals` 를 직접 호출해
 * FR-RS-14 Redis 캐시를 우회했다(cachedWorkspaceTotal 이 dead code). 이제
 * 워크스페이스 목록을 한 번 조회한 뒤 워크스페이스별로 `cachedWorkspaceTotal`
 * 을 read-through 로 태워 실제 캐시 + stampede 락이 동작하게 한다. zero-channel
 * 워크스페이스도 캐시 sentinel 로 한 줄(unread 0) 유지한다.
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeUnreadTotalsController {
  constructor(
    private readonly unread: UnreadService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('unread-totals')
  async totals(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ totals: UnreadWorkspaceTotal[] }> {
    // 멤버십이 정본 — 가입한 워크스페이스 id 를 한 번에 조회(zero-channel 포함).
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
      orderBy: { workspaceId: 'asc' },
    });
    // MAJOR-A: 워크스페이스별 read-through 캐시. 캐시 히트는 DB 를 치지 않는다.
    const totals = await Promise.all(
      memberships.map((m) => this.unread.cachedWorkspaceTotal(m.workspaceId, user.id)),
    );
    return { totals };
  }
}
