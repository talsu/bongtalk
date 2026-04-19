import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type CurrentChannelPayload = {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

export const CurrentChannel = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentChannelPayload | undefined => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { channel?: CurrentChannelPayload }>();
    return req.channel;
  },
);
