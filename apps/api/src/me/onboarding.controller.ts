import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';

/**
 * Task-016-C-1: GET /me/onboarding-status — four simple counts that
 * drive the sidebar checklist card. Counts only (no row fetch) so a
 * cheap 5-minute TanStack cache keeps this off the hot path for
 * dashboard renders.
 *
 * Never-reopen-after-dismiss is a client concern (localStorage
 * `qufox.onboarding.dismissed`); the server only reports state.
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class OnboardingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('onboarding-status')
  async status(@CurrentUser() user: CurrentUserPayload) {
    // Four counts in two phases: the three that only need userId run
    // together, then channel count runs once we know which workspace
    // row to aim at. Task-016 reviewer NIT cleanup: the earlier
    // parallel call carried a `Promise.resolve(0)` placeholder that
    // ran an unused slot in the tuple.
    const [workspaceRow, workspaceCount, invitesIssued, messagesSent] = await Promise.all([
      // Pick the oldest workspace for the "second channel" check so
      // the checklist stays stable when the user joins additional
      // workspaces later.
      this.prisma.workspaceMember.findFirst({
        where: { userId: user.id },
        select: { workspaceId: true },
        orderBy: { joinedAt: 'asc' },
      }),
      this.prisma.workspaceMember.count({ where: { userId: user.id } }),
      this.prisma.invite.count({ where: { createdById: user.id } }),
      this.prisma.message.count({ where: { authorId: user.id, deletedAt: null } }),
    ]);
    const channels = workspaceRow
      ? await this.prisma.channel.count({
          where: { workspaceId: workspaceRow.workspaceId, deletedAt: null },
        })
      : 0;

    return {
      workspaces: workspaceCount,
      channels,
      invitesIssued,
      messagesSent,
    };
  }
}
