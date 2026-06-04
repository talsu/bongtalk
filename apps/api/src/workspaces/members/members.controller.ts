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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  MEMBER_CURSOR_MAX_LENGTH,
  BulkMemberActionRequestSchema,
  ListMemberDirectoryQuerySchema,
  UpdateMemberRoleRequestSchema,
  type BulkMemberActionResponse,
} from '@qufox/shared-types';
import { MembersService } from './members.service';
import { ModerationService } from '../moderation/moderation.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/members')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    // S69 (FR-W11): 일괄 멤버 관리는 ModerationService 의 권한/계층 게이트를 재사용한다.
    private readonly moderation: ModerationService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // S27 (FR-P08/P09/P11/P12): status + hoist 그룹, bulkFor 단일 프레즌스 조회,
  // cursor 페이지네이션(limit 50), 1000명+ workspace 의 OFFLINE 그룹 기본 제외.
  // 마스킹(INVISIBLE→타인 offline)은 PresenceService.bulkFor 단일 지점에서 적용.
  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Query('cursor') cursor?: string,
    // FR-P11: include_offline=true|false override. 미지정 → workspace 규모 기본값.
    @Query('include_offline') includeOffline?: string,
  ) {
    // S27 fix-forward(security): cap the cursor length at the contract boundary
    // so an oversized/garbage cursor is rejected (VALIDATION_FAILED → 400) before
    // it reaches the base64url decode path — never a Prisma/decode 500. The
    // userId embedded in a well-formed cursor is additionally UUID-validated in
    // decodeCursor.
    if (typeof cursor === 'string' && cursor.length > MEMBER_CURSOR_MAX_LENGTH) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'cursor exceeds maximum length');
    }
    return this.members.listGrouped({
      workspaceId: member.workspaceId,
      viewerUserId: user.id,
      cursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined,
      includeOffline: parseIncludeOffline(includeOffline),
    });
  }

  // S69 (D13 / FR-W10): 멤버 디렉터리 — 검색/역할필터/가입일정렬/커서. 열람은 **모든
  // 워크스페이스 멤버**(Fork C — @Roles 없음 → WorkspaceMemberGuard 만으로 통과)에게
  // 허용한다. 관리 액션(역할변경/kick/ban/timeout)만 별도 권한 게이트를 거친다.
  @Get('directory')
  async directory(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('sortBy') sortBy?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsed = ListMemberDirectoryQuerySchema.safeParse({
      q: q === undefined || q === '' ? undefined : q,
      role: role === undefined || role === '' ? undefined : role,
      sortBy: sortBy === undefined || sortBy === '' ? undefined : sortBy,
      cursor: cursor === undefined || cursor === '' ? undefined : cursor,
    });
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.members.listDirectory({
      workspaceId: member.workspaceId,
      viewerUserId: user.id,
      // S69 fix-forward (security HIGH/BLOCKER): 뷰어 역할을 넘겨 email 검색/노출 +
      // 초대자 노출을 ADMIN+ 뷰어 전용으로 게이트한다(비관리자는 username-only + null).
      actorRole: member.role,
      q: parsed.data.q,
      role: parsed.data.role,
      sortBy: parsed.data.sortBy,
      cursor: parsed.data.cursor,
    });
  }

  @Roles('ADMIN')
  @Patch(':uid/role')
  async updateRole(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateMemberRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.members.updateRole(
      member.workspaceId,
      member.userId,
      member.role,
      targetUserId,
      parsed.data.role,
    );
  }

  @Roles('ADMIN')
  @Delete(':uid')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.members.remove(member.workspaceId, member.userId, member.role, targetUserId);
  }

  @Post('me/leave')
  @HttpCode(204)
  async leave(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.members.leave(member.workspaceId, user.id, member.role);
  }

  // S69 (D13 / FR-W11): 일괄 멤버 관리(kick/timeout/role · 최대 100명). @Roles 게이트를
  // 두지 않는 이유 — kick/timeout 은 MODERATOR 도 비트 보유 시 가능하고(등급 enum 만으론
  // 표현 불가), role 변경은 ADMIN+ 가 필요하다. 액션별 권한/계층 게이트는 ModerationService
  // .bulkAction 이 집행한다(actorRole 을 함께 넘겨 role 액션의 ADMIN+ 게이트를 판정).
  @Post('bulk-action')
  @HttpCode(200)
  async bulkAction(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<BulkMemberActionResponse> {
    // 폭주 방어 — moderation mutate rate-limit. S69 fix-forward (security MEDIUM):
    // 키를 **per-user 결합**해 한 멤버가 공유 버킷을 소진시켜 ADMIN 의 일괄 관리를
    // 방해하는 DoS 를 차단한다(workspace 단위 공유 버킷 → workspace+actor 결합 버킷).
    await this.rateLimit.enforce([
      {
        key: `moderation:mutate:ws:${member.workspaceId}:user:${member.userId}`,
        windowSec: 60,
        max: 30,
      },
    ]);
    const parsed = BulkMemberActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.moderation.bulkAction({
      workspaceId: member.workspaceId,
      actorId: member.userId,
      actorRole: member.role,
      action: parsed.data.action,
      userIds: parsed.data.userIds,
      durationSeconds: parsed.data.durationSeconds,
      role: parsed.data.role,
    });
  }
}

/**
 * S27 (FR-P11): parse the include_offline query flag. Accepts the common truthy
 * / falsy string spellings; anything else (or missing) → undefined so the
 * service falls back to the workspace-size default.
 */
function parseIncludeOffline(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}
