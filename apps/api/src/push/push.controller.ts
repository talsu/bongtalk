import { Body, Controller, Delete, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  PushSubscriptionRequestSchema,
  PushUnsubscribeRequestSchema,
  type VapidPublicKeyResponse,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PushService } from './push.service';

/**
 * S86 (D16 / FR-MN-15): Web Push(VAPID) REST.
 *
 *   GET    /push/vapid-public-key   — VAPID 공개키(비밀 아님). 프론트가 구독 직전 fetch.
 *                                     JwtAuthGuard 적용(인증 사용자만 — 키는 비밀 아니지만
 *                                     익명 노출 불필요). 키 미설정이면 publicKey='' 반환.
 *   POST   /me/push/subscriptions   — 구독 등록(upsert by endpoint·userId 스코프).
 *   DELETE /me/push/subscriptions   — 구독 해제(by endpoint·userId 스코프).
 *
 * 구독 endpoint/keys 는 항상 본인(@CurrentUser) 것으로만 저장/삭제한다(IDOR 방어 —
 * upsert/deleteMany 에 userId 동봉).
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('push/vapid-public-key')
  vapidPublicKey(): VapidPublicKeyResponse {
    return { publicKey: this.push.publicKey() };
  }

  @Post('me/push/subscriptions')
  @HttpCode(204)
  async subscribe(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
    @Headers('user-agent') ua?: string,
  ): Promise<void> {
    const parsed = PushSubscriptionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.PUSH_SUBSCRIPTION_INVALID, parsed.error.message);
    }
    await this.push.upsertSubscription(user.id, parsed.data, ua ?? null);
  }

  @Delete('me/push/subscriptions')
  @HttpCode(204)
  async unsubscribe(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown): Promise<void> {
    const parsed = PushUnsubscribeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.PUSH_SUBSCRIPTION_INVALID, parsed.error.message);
    }
    await this.push.removeSubscription(user.id, parsed.data.endpoint);
  }
}
