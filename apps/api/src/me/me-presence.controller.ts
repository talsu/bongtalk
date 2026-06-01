import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { PresencePreference } from '@prisma/client';
import { UpdatePresenceRequestSchema } from '@qufox/shared-types';
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
 *   PATCH /me/presence { status: "online" | "dnd" | "invisible" }
 *
 * - Persists to `User.presencePreference` (auto / dnd / invisible).
 * - Flips the per-workspace Redis SETs for every workspace the caller is in
 *   (S25: setPreferenceForUser — dnd joins the dnd SET, invisible leaves both
 *   online + dnd SET so only the caller sees themselves), so observers render
 *   the new state immediately without waiting for reconnect.
 * - Schedules a `presence.updated` broadcast per workspace through the existing
 *   throttler so a noisy UI flapper can't spam the channel.
 *
 * Rate limit: 20/min/user. A human tapping a presence chip takes seconds;
 * anything above 20/min is either a bug or abuse.
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
    @Body() body: { status?: 'online' | 'dnd' | 'invisible' },
  ): Promise<{
    preference: 'auto' | 'dnd' | 'invisible';
    effective: 'online' | 'dnd' | 'offline' | 'invisible';
  }> {
    await this.rate.enforce([{ key: `me-presence:u:${user.id}`, windowSec: 60, max: 20 }]);
    // S25 fix-forward(cheap · Zod): validate the body with the shared schema
    // (status ∈ {online,dnd,invisible}) so a non-whitelisted body / extra
    // fields are rejected at the contract boundary, mirroring the global
    // forbidNonWhitelisted ValidationPipe (which does not apply to a plain
    // `{ status?: ... }` body type without a class-validator DTO).
    const parsed = UpdatePresenceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'status must be "online", "dnd" or "invisible"',
      );
    }
    const status = parsed.data.status;
    // S25 (FR-P01): map the wire status → stored preference. "online" maps to
    // "auto" (005 semantics); dnd / invisible map 1:1.
    const preference: PresencePreference =
      status === 'dnd' ? 'dnd' : status === 'invisible' ? 'invisible' : 'auto';

    await this.prisma.user.update({
      where: { id: user.id },
      data: { presencePreference: preference },
    });

    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    const workspaceIds = memberships.map((m) => m.workspaceId);
    await this.presence.setPreferenceForUser(user.id, workspaceIds, preference);

    for (const wsId of workspaceIds) {
      this.gateway.schedulePresenceBroadcastPublic(wsId);
    }

    // S25: effective is the caller's OWN view (self), so invisible shows as
    // invisible to themselves (mask only applies to other viewers).
    const effective =
      preference === 'dnd' ? 'dnd' : preference === 'invisible' ? 'invisible' : 'online';
    return { preference, effective };
  }
}
