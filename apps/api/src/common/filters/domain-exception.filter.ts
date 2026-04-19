import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
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

    if (exception instanceof DomainError) {
      code = exception.code;
      status = ERROR_CODE_HTTP_STATUS[code];
      message = exception.message;
      const details = exception.details as { retryAfterSec?: number } | undefined;
      if (details && typeof details.retryAfterSec === 'number') {
        retryAfterSec = details.retryAfterSec;
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
    const body: { errorCode: string; message: string; requestId: string; retryAfterSec?: number } = {
      errorCode: code,
      message,
      requestId,
    };
    if (retryAfterSec !== undefined) body.retryAfterSec = retryAfterSec;
    res.status(status).json(body);
  }
}
