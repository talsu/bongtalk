import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type CurrentUserPayload = {
  id: string;
  email: string;
  username: string;
};

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentUserPayload | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: CurrentUserPayload }>();
    return req.user;
  },
);
