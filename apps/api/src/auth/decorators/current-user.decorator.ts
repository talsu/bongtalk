import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type CurrentUserPayload = {
  id: string;
  email: string;
  username: string;
  // S66 (D13 / FR-W05a): JWT 검증 시 함께 로드해 워크스페이스 진입·메시지 전송 게이트가
  // 별도 DB 왕복 없이 req.user.emailVerified 로 재확인할 수 있게 한다.
  emailVerified: boolean;
};

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentUserPayload | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: CurrentUserPayload }>();
    return req.user;
  },
);
