import { Body, Controller, Get, Patch } from '@nestjs/common';
import { SetDndScheduleRequestSchema, type DndSchedule } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DndScheduleService } from './dnd-schedule.service';

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
  async get(@CurrentUser() user: CurrentUserPayload): Promise<{
    schedule: DndSchedule | null;
    preference: 'auto' | 'dnd' | 'invisible';
  }> {
    // S28 (security MED fix-forward): GET 이 evaluateAndApply 를 호출해 전이 시
    // DB write 를 유발할 수 있으므로(스케줄 경계에서 presence 전환), GET 에도
    // rate-limit 을 건다. evaluateAndApply 는 이미 read→비교→조건부 write(전이가
    // 없으면 no-op)지만, 폴링(useDndSchedule refetchInterval 60s) 경로의 write 증폭을
    // 막기 위해 user 별 60req/60s 상한을 둔다(PATCH 의 30/60s 보다 폴링 친화적으로 큼).
    await this.rate.enforce([{ key: `me-dnd:u:${user.id}`, windowSec: 60, max: 60 }]);
    const schedule = await this.svc.get(user.id);
    // S28 (FR-P06): 평가 시점(요청 시) auto-toggle. GET 시점에 현재 시각이 구간
    // 안/밖인지 평가해 presencePreference 진입/종료 전이를 반영한다. 전이가 없으면
    // no-op(DB write 없음). 클라가 주기 폴링/연결 시 호출해 토글이 따라오게 한다.
    const { preference } = await this.svc.evaluateAndApply(user.id);
    return { schedule, preference };
  }

  @Patch()
  async set(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<{ schedule: DndSchedule | null; preference: 'auto' | 'dnd' | 'invisible' }> {
    await this.rate.enforce([{ key: `me-dnd:u:${user.id}`, windowSec: 60, max: 30 }]);
    // contract HIGH fix-forward: 요청 body 를 공유 Zod 스키마로 safeParse 한다(strict —
    // schema 키만 허용). 통과한 schedule(또는 null)만 service.set 에 전달한다. service
    // 가 다시 도메인 검증(entry 범위·개수 cap)을 하므로 이중 게이트다.
    const parsed = SetDndScheduleRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid dnd-schedule body (expected { schedule: DndSchedule | null })',
      );
    }
    // task-047 iter0 (MED-046-4): service.set 가 이제 DomainError 를 직접
    // throw 하므로 그대로 전파. 비-DomainError 만 generic VALIDATION_FAILED 로
    // wrap (e.g., 예상 못한 prisma 에러 등).
    try {
      const schedule = await this.svc.set(user.id, parsed.data.schedule);
      // S28 (FR-P06): 스케줄 저장 직후 즉시 평가. 방금 저장한 구간이 현재 활성이면
      // DND 로 진입(snapshot 보관)하고, 비활성으로 바꾼 경우 스냅샷이 있으면 복원한다.
      const { preference } = await this.svc.evaluateAndApply(user.id);
      return { schedule, preference };
    } catch (e) {
      if (e instanceof DomainError) throw e;
      const msg = e instanceof Error ? e.message : 'invalid schedule';
      throw new DomainError(ErrorCode.VALIDATION_FAILED, msg);
    }
  }
}
