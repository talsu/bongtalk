import {
  Body,
  Controller,
  DefaultValuePipe,
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
  CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  TransferOwnershipRequest,
  TransferOwnershipRequestSchema,
  UpdateWorkspaceRequest,
  UpdateWorkspaceRequestSchema,
} from '@qufox/shared-types';
import { WorkspacesService } from './workspaces.service';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { Roles } from './decorators/roles.decorator';
import { AllowSoftDeleted } from './decorators/allow-soft-deleted.decorator';
import { CurrentMember, CurrentMemberPayload } from './decorators/current-member.decorator';
import { WorkspaceMemberGuard } from './guards/workspace-member.guard';
import { WorkspaceRoleGuard } from './guards/workspace-role.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post()
  async create(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const parsed = CreateWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.workspaces.create(user.id, parsed.data as CreateWorkspaceRequest);
  }

  @Get()
  async listMine(@CurrentUser() user: CurrentUserPayload) {
    const workspaces = await this.workspaces.listMine(user.id);
    return { workspaces };
  }

  @Get('discover')
  async discover(
    @Query('category') category: string | undefined,
    @Query('q') q: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(20)) limitRaw: string | number,
  ) {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    return this.workspaces.discover({
      category,
      q,
      cursor: cursor ?? null,
      limit: limit || 20,
    });
  }

  @Post(':id/join')
  async joinPublic(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    // task-031-B: 5/min/user on PUBLIC join (abuse mitigation — a single
    // account sweeping hundreds of public workspaces).
    await this.rateLimit.enforce([{ key: `ws:join:${user.id}`, windowSec: 60, max: 5 }]);
    return this.workspaces.joinPublic(id, user.id);
  }

  @UseGuards(WorkspaceMemberGuard)
  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.workspaces.getWithMyRole(id, user.id);
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('ADMIN')
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // task-031-B: 10/hour/workspace on visibility changes only. Keep the
    // name/description PATCH path unthrottled since it's an everyday op.
    if (parsed.data.visibility !== undefined) {
      await this.rateLimit.enforce([{ key: `ws:visibility:${id}`, windowSec: 3600, max: 10 }]);
    }
    // task-030 reviewer B1: pass actor role so service can block ADMIN
    // attempts to flip visibility/category — OWNER-only.
    return this.workspaces.update(id, parsed.data as UpdateWorkspaceRequest, member.role);
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @Delete(':id')
  @HttpCode(202)
  async softDelete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const result = await this.workspaces.softDelete(id, user.id);
    return { deleteAt: result.deleteAt };
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @AllowSoftDeleted()
  @Post(':id/restore')
  async restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspaces.restore(id, user.id);
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @Post(':id/transfer-ownership')
  @HttpCode(200)
  async transfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = TransferOwnershipRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const input = parsed.data as TransferOwnershipRequest;
    return this.workspaces.transferOwnership(id, member.userId, input.toUserId);
  }
}
