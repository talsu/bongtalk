import { Body, Controller, Logger, Patch, UseGuards } from '@nestjs/common';
import { PresencePreference, Prisma } from '@prisma/client';
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
  private readonly logger = new Logger(MePresenceController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly rate: RateLimitService,
  ) {}

  @Patch('presence')
  async setPresence(
    @CurrentUser() user: CurrentUserPayload,
    // S26 fix-forward(contract LOW): the body is REQUIRED (Zod schema is
    // z.object({ status })), so the type hint mirrors that — `status` is not
    // optional. safeParse below still guards a missing/garbage body.
    @Body() body: { status: 'online' | 'dnd' | 'invisible' },
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

    // S27 (FR-P10): DND 전환은 "마지막 접속"으로 본다 → lastSeenAt 갱신. INVISIBLE
    // 전환은 잠적 시각이 누출되지 않도록 미갱신(auto/online 도 미갱신 — 접속 유지
    // 중이라 OFFLINE 확정 때만 별도 경로에서 찍는다). dnd 일 때만 stamp.
    //
    // S28 (reviewer M2 fix-forward): 사용자가 수동으로 presence 를 바꾸면 더 이상
    // "스케줄이 소유한 DND" 가 아니므로 dndScheduleSnapshot 을 클리어한다(JsonNull).
    // 그래야 스케줄 구간 중 수동으로 invisible 등으로 바꾼 뒤 구간이 끝나도
    // evaluateAndApply 의 종료 복원이 사용자 수동값을 덮어쓰지 않는다(scheduleOwnsDnd
    // = snapshot!==null 판정이 false 가 됨). 수동 의사 우선.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        presencePreference: preference,
        dndScheduleSnapshot: Prisma.JsonNull,
        ...(preference === 'dnd' ? { lastSeenAt: new Date() } : {}),
      },
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

    // S26 fix-forward(reviewer MAJOR-3 · HTTP P95): push the precise new status
    // to this user's direct subscribers (DM peers / viewport watchers) who may
    // not share a workspace room with them. fanOutPresenceUpdate does a
    // cluster-wide fetchSockets + per-viewer authz re-check — too heavy to block
    // the HTTP response on. Fire-and-forget: the response returns immediately and
    // the fan-out runs in the background, errors logged not thrown. The coarse
    // workspace broadcast above is already async (throttler-scheduled), so this
    // matches that pattern.
    void this.gateway.fanOutPresenceUpdatePublic(user.id).catch((err: unknown) => {
      this.logger.warn(
        `[me-presence] background presence fan-out failed user=${user.id} err=${String(err).slice(0, 200)}`,
      );
    });

    // S25: effective is the caller's OWN view (self), so invisible shows as
    // invisible to themselves (mask only applies to other viewers).
    const effective =
      preference === 'dnd' ? 'dnd' : preference === 'invisible' ? 'invisible' : 'online';
    return { preference, effective };
  }
}
