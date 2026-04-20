import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type CurrentMessagePayload = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  deletedAt: Date | null;
  createdAt: Date;
};

export const CurrentMessage = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentMessagePayload => {
    const req = ctx.switchToHttp().getRequest<{ message?: CurrentMessagePayload }>();
    if (!req.message) {
      throw new Error('CurrentMessage: use MessageAuthorGuard on this route');
    }
    return req.message;
  },
);
