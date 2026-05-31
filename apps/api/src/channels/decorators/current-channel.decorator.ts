import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type CurrentChannelPayload = {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  // S15 (FR-CH-08): 송신 경로 슬로우모드 게이트가 소비. ChannelAccessGuard 가
  // 채널을 로드할 때 함께 select 해 둔다(추가 쿼리 없음).
  slowmodeSeconds: number;
  isPrivate: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

export const CurrentChannel = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentChannelPayload | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { channel?: CurrentChannelPayload }>();
    return req.channel;
  },
);
