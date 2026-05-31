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
    // S05 (FR-MSG-06): 낙관적 잠금 충돌(MESSAGE_VERSION_CONFLICT) 시 서버 측
    // 현재 MessageDto 를 응답 body 의 `details.current` 로 그대로 실어보내
    // 클라이언트가 편집창을 최신값으로 롤백하게 합니다. 표준 에러 envelope
    // (errorCode/message/requestId)는 유지한 채 details 만 추가합니다.
    let details: unknown;

    if (exception instanceof DomainError) {
      code = exception.code;
      status = ERROR_CODE_HTTP_STATUS[code];
      message = exception.message;
      const d = exception.details as { retryAfterSec?: number; current?: unknown } | undefined;
      if (d && typeof d.retryAfterSec === 'number') {
        retryAfterSec = d.retryAfterSec;
      }
      if (d && d.current !== undefined) {
        details = { current: d.current };
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
      details?: unknown;
    } = {
      errorCode: code,
      message,
      requestId,
    };
    if (retryAfterSec !== undefined) body.retryAfterSec = retryAfterSec;
    if (details !== undefined) body.details = details;
    res.status(status).json(body);
  }
}
