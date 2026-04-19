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
import { UpdateRoleRequestSchema } from '@qufox/shared-types';
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

  @Get()
  async list(@Param('id', new ParseUUIDPipe()) _id: string, @CurrentMember() member: CurrentMemberPayload) {
    const rows = await this.members.list(member.workspaceId);
    return {
      members: rows.map((row) => ({
        workspaceId: row.workspaceId,
        userId: row.userId,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        user: row.user,
      })),
    };
  }

  @Roles('ADMIN')
  @Patch(':uid/role')
  async updateRole(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('uid', new ParseUUIDPipe()) targetUserId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateRoleRequestSchema.safeParse(body);
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
    await this.members.remove(
      member.workspaceId,
      member.userId,
      member.role,
      targetUserId,
    );
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
