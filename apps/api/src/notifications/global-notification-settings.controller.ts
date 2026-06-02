import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { UpdateGlobalNotificationSettingsRequestSchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import type { DndSchedule } from '../me/dnd-schedule.service';
import { NotifPreferencesService } from './notif-preferences.service';

/**
 * S46 (D06 / FR-MN-05): 글로벌 알림 설정 API.
 *
 *   GET   /me/settings/notifications  → 현재 글로벌 설정(행 없으면 MENTIONS 기본).
 *   PATCH /me/settings/notifications  → 부분 업데이트(upsert).
 *
 * 기존 /me/notification-preferences(TOAST/BROWSER)와는 별도 URL 이다 — breaking
 * 금지(두 축 병행). NotifLevel(ALL/MENTIONS/NOTHING) + keywords + dndUntil +
 * dndSchedule 을 다룬다. keywords 스캔은 BullMQ(S45) 후속이라 컬럼 저장만.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/settings/notifications')
export class GlobalNotificationSettingsController {
  constructor(private readonly prefs: NotifPreferencesService) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload) {
    return this.prefs.getGlobal(user.id);
  }

  @Patch()
  async update(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const parsed = UpdateGlobalNotificationSettingsRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.prefs.updateGlobal(user.id, {
      notifTrigger: parsed.data.notifTrigger,
      keywords: parsed.data.keywords,
      dndUntil: parsed.data.dndUntil,
      // 키 부재(undefined) = 미변경, 명시적 null = 스케줄 해제. 둘을 구별해 전달.
      dndSchedule:
        'dndSchedule' in parsed.data ? (parsed.data.dndSchedule as DndSchedule | null) : undefined,
    });
  }
}
