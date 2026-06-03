import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  BanMemberRequestSchema,
  KickMemberRequestSchema,
  KickUndoRequestSchema,
  TimeoutMemberRequestSchema,
  type KickMemberResponse,
  type ListBansResponse,
  type TimeoutMemberResponse,
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

  /** FR-RM06: userId 영구 차단(멤버/비멤버). 사유 + AuditLog 필수. Undo 없음. */
  @Post('bans')
  @HttpCode(204)
  async ban(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<void> {
    await this.enforceMutateLimit(member.workspaceId);
    const parsed = BanMemberRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.moderation.ban({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      targetUserId: parsed.data.userId,
      reason: parsed.data.reason,
    });
  }

  /** FR-RM06: 차단 해제. 미차단이면 404 MEMBER_NOT_BANNED. */
  @Delete('bans/:uid')
  @HttpCode(204)
  async unban(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ): Promise<void> {
    await this.enforceMutateLimit(member.workspaceId);
    await this.moderation.unban({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      targetUserId,
    });
  }

  /** FR-RM06: 차단 목록(권한자). 최신 차단 순. */
  @Get('bans')
  async listBans(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ): Promise<ListBansResponse> {
    return this.moderation.listBans({
      workspaceId: member.workspaceId,
      actorId: member.userId,
    });
  }

  /** FR-RM07: 멤버 임시 음소거(60초~7일). 기간 중 전송/반응/슬래시 차단. */
  @Post('members/:uid/timeout')
  @HttpCode(200)
  async timeout(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<TimeoutMemberResponse> {
    await this.enforceMutateLimit(member.workspaceId);
    const parsed = TimeoutMemberRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.moderation.timeout({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      targetUserId,
      durationSeconds: parsed.data.durationSeconds,
      reason: parsed.data.reason,
    });
  }

  /** FR-RM07: 음소거 수동 해제. */
  @Delete('members/:uid/timeout')
  @HttpCode(204)
  async untimeout(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ): Promise<void> {
    await this.enforceMutateLimit(member.workspaceId);
    await this.moderation.untimeout({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      targetUserId,
    });
  }
}
