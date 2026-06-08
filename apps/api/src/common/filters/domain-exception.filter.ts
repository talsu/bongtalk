import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { ERROR_CODE_HTTP_STATUS, ErrorCode } from '../errors/error-code.enum';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string) ?? 'unknown';

    let code: ErrorCode = ErrorCode.INTERNAL;
    let status = 500;
    let message = 'Internal error';
    let retryAfterSec: number | undefined;
    // S15 (FR-CH-08): 슬로우모드 잔여 시간을 밀리초 단위로 클라이언트에 전달한다
    // (CHANNEL_SLOWMODE_ACTIVE). retry-after 헤더는 초 단위(HTTP 표준)로 올림하고,
    // 정밀 카운트다운용 retryAfterMs 는 body 에 함께 싣는다.
    let retryAfterMs: number | undefined;
    // S05 (FR-MSG-06): 낙관적 잠금 충돌(MESSAGE_VERSION_CONFLICT) 시 서버 측
    // 현재 MessageDto 를 응답 body 의 `details.current` 로 그대로 실어보내
    // 클라이언트가 편집창을 최신값으로 롤백하게 합니다. 표준 에러 envelope
    // (errorCode/message/requestId)는 유지한 채 details 만 추가합니다.
    let details: unknown;

    if (exception instanceof DomainError) {
      code = exception.code;
      status = ERROR_CODE_HTTP_STATUS[code];
      message = exception.message;
      const d = exception.details as
        | {
            retryAfterSec?: number;
            retryAfterMs?: number;
            current?: unknown;
            // S73 (D14 / FR-PS-03): 핸들 쿨다운 거부 시 다음 변경 가능 시각(ISO)을
            // 클라이언트에 전달해 "다음 변경 가능일 D-N" 안내를 즉시 갱신하게 한다.
            nextAllowedAt?: string;
            // S94 (067 / FR-MSG-14): BULK_MENTION_CONFIRM_REQUIRED 시 클라이언트가 확인
            // dialog 카피("@channel 이 N명에게 알림…")에 쓸 멘션 종류/대상 수/임계값.
            mention?: string;
            count?: number;
            threshold?: number;
          }
        | undefined;
      if (d && typeof d.retryAfterSec === 'number') {
        retryAfterSec = d.retryAfterSec;
      }
      if (d && typeof d.retryAfterMs === 'number') {
        retryAfterMs = d.retryAfterMs;
        // HTTP retry-after 헤더는 초 단위 정수. 잔여가 1초 미만이어도 최소 1초.
        if (retryAfterSec === undefined) {
          retryAfterSec = Math.max(1, Math.ceil(d.retryAfterMs / 1000));
        }
      }
      if (d && d.current !== undefined) {
        details = { current: d.current };
      }
      // S73 (D14 / FR-PS-03): HANDLE_COOLDOWN_ACTIVE 의 nextAllowedAt 전달.
      if (d && typeof d.nextAllowedAt === 'string') {
        details = { ...(details as object | undefined), nextAllowedAt: d.nextAllowedAt };
      }
      // S94 (067 / FR-MSG-14): BULK_MENTION_CONFIRM_REQUIRED 의 mention/count/threshold
      // 를 body.details 로 실어 클라이언트가 확인 dialog 카피를 정확히 구성하게 한다.
      if (code === ErrorCode.BULK_MENTION_CONFIRM_REQUIRED && d && typeof d.mention === 'string') {
        details = {
          ...(details as object | undefined),
          mention: d.mention,
          count: d.count,
          threshold: d.threshold,
        };
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.message;
      if (status === 400) code = ErrorCode.VALIDATION_FAILED;
      else if (status === 401) code = ErrorCode.AUTH_INVALID_TOKEN;
      else if (status === 404) code = ErrorCode.NOT_FOUND;
      else if (status === 429) code = ErrorCode.RATE_LIMITED;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(
      JSON.stringify({
        requestId,
        errorCode: code,
        status,
        path: req.url,
        message,
        stack: status === 500 ? stack : undefined,
      }),
    );

    res.setHeader('x-request-id', requestId);
    if (retryAfterSec !== undefined) {
      res.setHeader('retry-after', String(retryAfterSec));
    }
    const body: {
      errorCode: string;
      message: string;
      requestId: string;
      retryAfterSec?: number;
      retryAfterMs?: number;
      details?: unknown;
    } = {
      errorCode: code,
      message,
      requestId,
    };
    if (retryAfterSec !== undefined) body.retryAfterSec = retryAfterSec;
    if (retryAfterMs !== undefined) body.retryAfterMs = retryAfterMs;
    if (details !== undefined) body.details = details;
    res.status(status).json(body);
  }
}
