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
    // Run all four counts in parallel. The individual indexes already
    // exist from task-002/003/005/011 (WorkspaceMember.userId,
    // Channel.workspaceId, Invite.createdById, Message.authorId). No
    // extra migration needed.
    const [workspaceRow, workspaceCount, channelCount, invitesIssued, messagesSent] =
      await Promise.all([
        // Pick an arbitrary workspace for the "second channel" check —
        // the checklist treats any workspace as representative; real
        // multi-workspace users already have multi-channel elsewhere.
        this.prisma.workspaceMember.findFirst({
          where: { userId: user.id },
          select: { workspaceId: true },
          orderBy: { joinedAt: 'asc' },
        }),
        this.prisma.workspaceMember.count({ where: { userId: user.id } }),
        // channelCount resolved against the user's first workspace so
        // "second channel" means "beyond the default #general".
        Promise.resolve(0), // filled below
        this.prisma.invite.count({ where: { createdById: user.id } }),
        this.prisma.message.count({ where: { authorId: user.id, deletedAt: null } }),
      ]);
    const channels = workspaceRow
      ? await this.prisma.channel.count({
          where: { workspaceId: workspaceRow.workspaceId, deletedAt: null },
        })
      : 0;
    void channelCount;

    return {
      workspaces: workspaceCount,
      channels,
      invitesIssued,
      messagesSent,
    };
  }
}
