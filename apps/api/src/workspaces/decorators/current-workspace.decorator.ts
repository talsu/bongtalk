import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type CurrentWorkspacePayload = {
  id: string;
  slug: string;
  ownerId: string;
  deletedAt: Date | null;
};

export const CurrentWorkspace = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentWorkspacePayload | undefined => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { workspace?: CurrentWorkspacePayload }>();
    return req.workspace;
  },
);
