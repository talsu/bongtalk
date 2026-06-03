import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceRole } from '@qufox/shared-types';

export type CurrentMemberPayload = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  // S63 fix-forward (perf C-1): WorkspaceMemberGuard 가 멤버십 조회에 편승해 싣는 활성
  // 음소거 만료 시각(없으면 null). send hot-path 가 별도 isTimedOut 왕복 없이 인라인으로
  // 타임아웃을 판정한다(mutedUntil > now). 만료/미설정이면 통과(lazy).
  mutedUntil: Date | null;
};

export const CurrentMember = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentMemberPayload | undefined => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { workspaceMember?: CurrentMemberPayload }>();
    return req.workspaceMember;
  },
);
