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
  UseGuards,
} from '@nestjs/common';
import {
  CreateRoleRequestSchema,
  UpdateRoleRequestSchema,
  AssignRoleRequestSchema,
} from '@qufox/shared-types';
import { RolesService } from './roles.service';
import { MemberRoleService } from './member-role.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S61 (D12 / FR-RM01·04·15): 워크스페이스 역할 관리 REST.
 *
 * 조회는 멤버 전체, 생성/수정/삭제/배정은 ADMIN 이상(@Roles('ADMIN')) 게이트 +
 * 서비스 레이어의 privilege escalation 방어(액터 권한·position 기준)로 이중 보호한다.
 */
@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/roles')
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly memberRoles: MemberRoleService,
  ) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    return this.roles.list(member.workspaceId);
  }

  @Roles('ADMIN')
  @Post()
  async create(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = CreateRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.roles.create(member.workspaceId, user.id, parsed.data);
  }

  @Roles('ADMIN')
  @Patch(':roleId')
  async update(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('roleId', new ParseUUIDPipe()) roleId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.roles.update(member.workspaceId, user.id, roleId, parsed.data);
  }

  @Roles('ADMIN')
  @Delete(':roleId')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('roleId', new ParseUUIDPipe()) roleId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.roles.remove(member.workspaceId, user.id, roleId);
  }

  // ── 멤버 역할 배정 ──────────────────────────────────────────────────────────

  @Roles('ADMIN')
  @Post('assign')
  @HttpCode(204)
  async assign(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = AssignRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.memberRoles.assign(
      member.workspaceId,
      user.id,
      parsed.data.userId,
      parsed.data.roleId,
    );
  }

  @Roles('ADMIN')
  @Delete('assign/:targetUserId/:roleId')
  @HttpCode(204)
  async revoke(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('targetUserId', new ParseUUIDPipe()) targetUserId: string,
    @Param('roleId', new ParseUUIDPipe()) roleId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.memberRoles.revoke(member.workspaceId, user.id, targetUserId, roleId);
  }
}
