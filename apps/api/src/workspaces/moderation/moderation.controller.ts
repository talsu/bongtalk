import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  KickMemberRequestSchema,
  KickUndoRequestSchema,
  type KickMemberResponse,
} from '@qufox/shared-types';
import { ModerationService } from './moderation.service';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S63 (D12 / FR-RM05·06·07): 모더레이션(Kick / Ban / Timeout) REST.
 *
 * WorkspaceMemberGuard 로 멤버임만 확인하고(@Roles 등급 게이트 대신), 권한 비트
 * (KICK/BAN/TIMEOUT_MEMBERS)와 position 계층 방어는 ModerationService 가 집행한다
 * (MODERATOR 도 비트 보유 시 모더레이션 가능 — 등급 enum 만으로는 표현 불가).
 */
@UseGuards(WorkspaceMemberGuard)
@Controller('workspaces/:id/moderation')
export class ModerationController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // 모더레이션 mutate 는 per-workspace rate-limit(roles.controller 패턴). 폭주 방어.
  private async enforceMutateLimit(workspaceId: string): Promise<void> {
    await this.rateLimit.enforce([
      { key: `moderation:mutate:ws:${workspaceId}`, windowSec: 60, max: 30 },
    ]);
  }

  /** FR-RM05: 멤버 강제 퇴장. actor 에게만 5초 Undo 토큰을 반환한다(브로드캐스트 제외). */
  @Post('members/:uid/kick')
  @HttpCode(200)
  async kick(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<KickMemberResponse> {
    await this.enforceMutateLimit(member.workspaceId);
    const parsed = KickMemberRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.moderation.kick({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      targetUserId,
      reason: parsed.data.reason,
    });
  }

  /** FR-RM05: kick 5초 Undo. 만료/무효/재가입 시 409 KICK_UNDO_INVALID. */
  @Post('members/:uid/kick-undo')
  @HttpCode(204)
  async kickUndo(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = KickUndoRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.moderation.kickUndo({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      targetUserId,
      undoToken: parsed.data.undoToken,
    });
  }
}
