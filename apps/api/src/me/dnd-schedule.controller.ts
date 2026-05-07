import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DndScheduleService, DndSchedule } from './dnd-schedule.service';

/**
 * task-046 iter4 (K1):
 *   GET   /me/dnd-schedule  → { schedule: DndSchedule | null }
 *   PATCH /me/dnd-schedule  body: { schedule: DndSchedule | null }
 *
 * Rate limit: 30/min/user (UI 토글 기준 충분).
 */
@Controller('me/dnd-schedule')
export class DndScheduleController {
  constructor(
    private readonly svc: DndScheduleService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<{ schedule: DndSchedule | null }> {
    const schedule = await this.svc.get(user.id);
    return { schedule };
  }

  @Patch()
  async set(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { schedule?: unknown },
  ): Promise<{ schedule: DndSchedule | null }> {
    await this.rate.enforce([{ key: `me-dnd:u:${user.id}`, windowSec: 60, max: 30 }]);
    try {
      const schedule = await this.svc.set(user.id, body?.schedule ?? null);
      return { schedule };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'invalid schedule';
      throw new DomainError(ErrorCode.VALIDATION_FAILED, msg);
    }
  }
}
