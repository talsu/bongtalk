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
import { MEMBER_CURSOR_MAX_LENGTH, UpdateMemberRoleRequestSchema } from '@qufox/shared-types';
import { MembersService } from './members.service';
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
  constructor(private readonly members: MembersService) {}

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
