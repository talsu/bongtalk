import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { StatusBroadcastThrottler } from './status-broadcast-throttler';
import { CustomStatusService, CustomStatusView, maskExpiredStatus } from './custom-status.service';
import { SetCustomStatusInputSchema } from '@qufox/shared-types';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S28 (FR-P04 + FR-P17): Discord-parity 구조화 커스텀 상태.
 *
 *   GET    /users/me/status  → { text, emoji, expiresAt }  (lazy 만료 적용)
 *   PUT    /users/me/status  { text?, emoji?, expiresAt?, preset?, timezone? }
 *   DELETE /users/me/status  → 204 / 빈 상태
 *
 * - text + emoji + expiresAt(UTC). preset 은 timezone 기준 expiresAt 계산용
 *   fallback(클라가 직접 expiresAt 을 보내면 그것을 우선).
 * - FR-P17 만료: read-time lazy clear(GET 이 expiresAt<now 면 빈 상태 반환 +
 *   DB best-effort 정리). 별도 cron 은 DEFER.
 * - 기존 PATCH /me/profile/status(text-only)는 호환을 위해 유지된다.
 *
 * 갱신/삭제 시 기존 status-broadcast 와 동일하게 user.profile.updated 를 워크스페이스
 * 룸으로 throttle-broadcast 한다(customStatus 텍스트 기준 캐시 갱신).
 *
 * Rate limit: 60/min/user(기존 me-status 와 동일 — 사람 토글엔 충분히 큼).
 */
@Controller('users/me/status')
export class CustomStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
    private readonly svc: CustomStatusService,
    private readonly gateway: RealtimeGateway,
    private readonly throttler: StatusBroadcastThrottler,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<CustomStatusView> {
    return this.svc.getEffective(user.id);
  }

  @Put()
  async set(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<CustomStatusView> {
    await this.rate.enforce([{ key: `me-status:u:${user.id}`, windowSec: 60, max: 60 }]);
    // contract HIGH fix-forward: 요청 body 를 공유 Zod 스키마로 safeParse 한다(strict —
    // 비-화이트리스트 필드 거부). 통과한 입력만 service.normalizeInput 에 전달한다.
    const parsed = SetCustomStatusInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid custom status body (text/emoji/expiresAt/preset/timezone)',
      );
    }
    const view = await this.svc.set(user.id, parsed.data);
    this.scheduleBroadcast(user.id);
    return view;
  }

  @Delete()
  async clear(@CurrentUser() user: CurrentUserPayload): Promise<CustomStatusView> {
    await this.rate.enforce([{ key: `me-status:u:${user.id}`, windowSec: 60, max: 60 }]);
    await this.svc.clear(user.id);
    this.scheduleBroadcast(user.id);
    return { text: null, emoji: null, expiresAt: null };
  }

  /**
   * 기존 MeStatusController 와 동일한 throttle-broadcast 패턴. flush 시점에 최신
   * customStatus 텍스트를 재조회해 빠른 토글의 마지막 값을 반영한다.
   */
  private scheduleBroadcast(userId: string): void {
    this.throttler.schedule(userId, async () => {
      const fresh = await this.prisma.user.findUnique({
        where: { id: userId },
        // S28 (HIGH-2 + FR-P17): expiresAt 도 함께 읽어 flush 시점에 만료 마스킹한다.
        // 빠른 토글의 마지막 값이 이미 만료됐다면 만료분을 브로드캐스트하지 않는다
        // (멤버목록·DM 노출 경로와 동일 판정).
        select: { customStatus: true, customStatusExpiresAt: true },
      });
      const memberships = await this.prisma.workspaceMember.findMany({
        where: { userId, workspace: { deletedAt: null } },
        select: { workspaceId: true },
      });
      const masked = maskExpiredStatus({
        text: fresh?.customStatus ?? null,
        emoji: null,
        expiresAt: fresh?.customStatusExpiresAt ?? null,
        now: new Date(),
      });
      this.gateway.broadcastUserProfileUpdate({
        userId,
        workspaceIds: memberships.map((m) => m.workspaceId),
        customStatus: masked.text,
      });
    });
  }
}
