import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { PresencePreference } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';
import { PresenceService } from '../realtime/presence/presence.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Task-019-C: user-facing DnD toggle.
 *
 *   PATCH /me/presence { status: "online" | "dnd" }
 *
 * - Persists to `User.presencePreference`.
 * - Flips the per-workspace Redis DnD SET for every workspace the
 *   caller is in, so observers render the new state immediately
 *   without waiting for reconnect.
 * - Schedules a `presence.updated` broadcast per workspace through
 *   the existing throttler so a noisy UI flapper can't spam the
 *   channel.
 *
 * Rate limit: 20/min/user. A human tapping "Do Not Disturb" takes
 * seconds; anything above 20/min is either a bug or abuse.
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MePresenceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly rate: RateLimitService,
  ) {}

  @Patch('presence')
  async setPresence(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { status?: 'online' | 'dnd' },
  ): Promise<{ preference: 'auto' | 'dnd'; effective: 'online' | 'dnd' | 'offline' }> {
    await this.rate.enforce([{ key: `me-presence:u:${user.id}`, windowSec: 60, max: 20 }]);
    const status = body?.status;
    if (status !== 'online' && status !== 'dnd') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'status must be "online" or "dnd"');
    }
    const preference: PresencePreference = status === 'dnd' ? 'dnd' : 'auto';

    await this.prisma.user.update({
      where: { id: user.id },
      data: { presencePreference: preference },
    });

    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    const workspaceIds = memberships.map((m) => m.workspaceId);
    await this.presence.setDndForUser(user.id, workspaceIds, preference === 'dnd');

    for (const wsId of workspaceIds) {
      this.gateway.schedulePresenceBroadcastPublic(wsId);
    }

    return {
      preference,
      effective: preference === 'dnd' ? 'dnd' : 'online',
    };
  }
}
