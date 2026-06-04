import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  UpdateWorkspaceMemberProfileInputSchema,
  WsAvatarPresignInputSchema,
  WsAvatarFinalizeInputSchema,
  type WorkspaceMemberProfileView,
  type WsAvatarPresignResult,
  type WsAvatarFinalizeResult,
  type MemberFullProfileView,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { PrismaService } from '../../prisma/prisma.module';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceMemberProfileService } from './workspace-member-profile.service';

/**
 * S74 (D14 / FR-PS-06 · Fork2 Option B): 워크스페이스별 프로필 read/edit + ws아바타.
 *
 *   GET    /workspaces/:wsId/me/profile                  → 본인 ws 프로필
 *   PATCH  /workspaces/:wsId/me/profile                  → 본인 닉네임/About Me 부분 갱신
 *   POST   /workspaces/:wsId/me/profile/avatar/presign   → ws아바타 presigned POST
 *   PUT    /workspaces/:wsId/me/profile/avatar           → ws아바타 확정
 *   DELETE /workspaces/:wsId/me/profile/avatar           → ws아바타 제거
 *   GET    /workspaces/:wsId/members/:userId/profile     → 같은 ws 멤버의 ws 프로필
 *
 * WorkspaceMemberGuard 가 `:wsId` 멤버십(IDOR 방어)을 강제한다. 타멤버 조회는 추가로 대상
 * userId 가 같은 워크스페이스 멤버인지 검증한다(비멤버 enumeration 차단 → 404).
 * ws프로필 변경 시 workspace_profile.updated 를 해당 워크스페이스 룸으로 fanout 한다.
 *
 * Rate limit: presign 5/min, 그 외 ws-profile:u:{id} 10/min.
 */
@UseGuards(WorkspaceMemberGuard)
@Controller('workspaces/:wsId')
export class WorkspaceMemberProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
    private readonly svc: WorkspaceMemberProfileService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Get('me/profile')
  async getMine(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<WorkspaceMemberProfileView> {
    return this.svc.getProfile(wsId, user.id);
  }

  @Patch('me/profile')
  async patchMine(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WorkspaceMemberProfileView> {
    await this.rate.enforce([{ key: `ws-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    const parsed = UpdateWorkspaceMemberProfileInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid workspace profile body (nickname/workspaceBio)',
      );
    }
    const view = await this.svc.updateProfile(wsId, user.id, parsed.data);
    this.broadcast(wsId, user.id, view);
    return view;
  }

  @Post('me/profile/avatar/presign')
  async presignAvatar(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WsAvatarPresignResult> {
    await this.rate.enforce([{ key: `ws-avatar-presign:u:${user.id}`, windowSec: 60, max: 5 }]);
    const parsed = WsAvatarPresignInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid ws avatar presign body (contentType/sizeBytes)',
      );
    }
    return this.svc.presignAvatar(wsId, user.id, parsed.data.contentType, parsed.data.sizeBytes);
  }

  @Put('me/profile/avatar')
  async finalizeAvatar(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WsAvatarFinalizeResult> {
    await this.rate.enforce([{ key: `ws-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    const parsed = WsAvatarFinalizeInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid ws avatar finalize body (key)');
    }
    const result = await this.svc.finalizeAvatar(wsId, user.id, parsed.data.key);
    const view = await this.svc.getProfile(wsId, user.id);
    this.broadcast(wsId, user.id, view);
    return result;
  }

  @Delete('me/profile/avatar')
  @HttpCode(204)
  async removeAvatar(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rate.enforce([{ key: `ws-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    await this.svc.deleteAvatar(wsId, user.id);
    const view = await this.svc.getProfile(wsId, user.id);
    this.broadcast(wsId, user.id, view);
  }

  @Get('members/:userId/profile')
  async getMember(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
  ): Promise<WorkspaceMemberProfileView> {
    // 대상이 같은 워크스페이스 멤버인지 검증(비멤버 enumeration 차단 → 404).
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'member not found in this workspace');
    }
    return this.svc.getProfile(wsId, targetUserId);
  }

  /**
   * S75 (D14 / FR-PS-07·08 · Fork A-1): 타 멤버 전체 프로필(팝오버 미니카드 + 전체 패널).
   *   GET /workspaces/:wsId/members/:userId/full-profile → MemberFullProfileView
   *
   * WorkspaceMemberGuard 가 요청자(viewer)의 :wsId 멤버십을 강제하고, 여기서 대상 userId 가
   * 동일 wsId 멤버인지 검증한다(비멤버 → 404 enumeration 차단 — getMember 권한 패턴 재사용).
   * 합성(전역+ws오버라이드+프레즌스+역할+커스텀상태)은 서비스가 단일 출처로 수행한다.
   *
   * Rate limit: 읽기전용이라 완화한다(member-profile:u:{viewerId} 20/min — 팝오버 여러 번
   * 열기 허용). 본인-조회도 동일 경로로 허용한다(자기 프로필 미리보기).
   */
  @Get('members/:userId/full-profile')
  async getMemberFullProfile(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<MemberFullProfileView> {
    await this.rate.enforce([{ key: `member-profile:u:${user.id}`, windowSec: 60, max: 20 }]);
    // 대상이 같은 워크스페이스 멤버인지 검증(비멤버 enumeration 차단 → 404). getMember 일관.
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: wsId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'member not found in this workspace');
    }
    return this.svc.getFullProfile(wsId, user.id, targetUserId);
  }

  /**
   * ws프로필 변경(닉네임/아바타) → 해당 워크스페이스 룸으로 workspace_profile.updated fanout.
   * dispatcher 가 멤버목록 캐시의 wsNickname/wsAvatarUrl 을 패치(없으면 invalidate 폴백)한다.
   */
  private broadcast(workspaceId: string, userId: string, view: WorkspaceMemberProfileView): void {
    this.gateway.broadcastWorkspaceProfileUpdate({
      workspaceId,
      userId,
      wsNickname: view.nickname,
      wsAvatarUrl: view.avatarUrl,
    });
  }
}
