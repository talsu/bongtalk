import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { IncomingWebhookPayloadSchema } from '@qufox/shared-types';
import { WebhooksService } from './webhooks.service';
import { Public } from '../../auth/decorators/public.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S84a (D16 / FR-RC11) — 인커밍 웹훅 게시 엔드포인트.
 *
 * `POST /webhooks/:webhookId` 는 워크스페이스 멤버 가드를 적용하지 않는다 — 웹훅
 * 토큰 자체가 인증이다(@Public 으로 전역 JwtAuthGuard 우회). 토큰은 표준
 * `Authorization: Bearer <token>` 헤더 또는 생성 응답의 postUrl 과 정합되는
 * `?token=` 쿼리로 전달할 수 있다(둘 다 없으면 401 대신 INVALID_TOKEN 403 으로 통일).
 *
 * 서비스(verifyAndPost)가 timingSafeEqual 토큰 검증·예약어·rate-limit·BOT 메시지
 * 생성을 담당하며, 폐기/회전 토큰은 403, 예약어 username 은 422 다.
 */
@Public()
@Controller('webhooks')
export class IncomingWebhookController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':webhookId')
  @HttpCode(201)
  async post(
    @Param('webhookId', new ParseUUIDPipe()) webhookId: string,
    @Headers('authorization') authHeader: string | undefined,
    @Query('token') queryToken: string | undefined,
    // S84a 리뷰 fix-forward (security LOW-7): per-IP rate-limit 키용 클라이언트 IP.
    // main.ts 의 trust proxy=1 로 X-Forwarded-For 첫 홉이 req.ip 로 복원된다.
    @Ip() clientIp: string,
    @Body() body: unknown,
  ) {
    const rawToken = extractToken(authHeader, queryToken);
    if (!rawToken) {
      // 토큰 부재도 존재 노출을 피해 INVALID_TOKEN(403)으로 통일한다.
      throw new DomainError(ErrorCode.WEBHOOK_INVALID_TOKEN, 'missing webhook token');
    }
    const parsed = IncomingWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.webhooks.verifyAndPost(webhookId, rawToken, parsed.data, clientIp);
  }
}

/**
 * `Authorization: Bearer <token>` 우선, 없으면 `?token=` 쿼리. 둘 다 없으면 null.
 * Bearer 접두는 대소문자 무시. 빈 문자열은 null 로 정규화.
 */
function extractToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string | null {
  if (authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m && m[1].trim()) return m[1].trim();
  }
  if (queryToken && queryToken.trim()) return queryToken.trim();
  return null;
}
