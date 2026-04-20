import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import type { NotificationChannel as NC, NotificationEventType as NET } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationPreferencesService } from './notification-preferences.service';

const EVENT_TYPES: readonly NET[] = ['MENTION', 'REPLY', 'REACTION', 'DIRECT'];
const CHANNELS: readonly NC[] = ['TOAST', 'BROWSER', 'BOTH', 'OFF'];

/**
 * Task-019-D: user-facing notification preferences API.
 *
 *   GET  /me/notification-preferences        → every row the user owns
 *   PUT  /me/notification-preferences        → upsert one row
 *
 * ACL: if `workspaceId` is provided, the caller must be a member of
 * that workspace (403 otherwise). `workspaceId: null` is always OK
 * and sets the global default.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/notification-preferences')
export class NotificationPreferencesController {
  constructor(
    private readonly prefs: NotificationPreferencesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload) {
    const rows = await this.prefs.list(user.id);
    return {
      preferences: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        eventType: r.eventType,
        channel: r.channel,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  @Put()
  async upsert(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { workspaceId?: string | null; eventType?: string; channel?: string },
  ) {
    const { workspaceId: rawWs, eventType: rawEv, channel: rawCh } = body ?? {};
    if (!rawEv || !EVENT_TYPES.includes(rawEv as NET)) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'eventType invalid');
    }
    if (!rawCh || !CHANNELS.includes(rawCh as NC)) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'channel invalid');
    }
    const workspaceId = rawWs ?? null;
    if (workspaceId) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        select: { userId: true },
      });
      if (!member) {
        throw new DomainError(
          ErrorCode.WORKSPACE_NOT_MEMBER,
          'cannot set preferences for a workspace you are not a member of',
        );
      }
    }
    const row = await this.prefs.upsert({
      userId: user.id,
      workspaceId,
      eventType: rawEv as NET,
      channel: rawCh as NC,
    });
    return { id: row.id };
  }
}
