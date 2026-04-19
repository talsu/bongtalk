import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceRole } from '@qufox/shared-types';

export type CurrentMemberPayload = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
};

export const CurrentMember = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentMemberPayload | undefined => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { workspaceMember?: CurrentMemberPayload }>();
    return req.workspaceMember;
  },
);
