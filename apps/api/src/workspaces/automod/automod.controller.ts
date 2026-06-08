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
  CreateAutoModRuleRequestSchema,
  UpdateAutoModRuleRequestSchema,
} from '@qufox/shared-types';
import { AutoModService } from './automod.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * FR-RM10a (063 / ADR E5): 워크스페이스 AutoMod 규칙 관리 REST.
 *
 * 조회·생성·수정·삭제 모두 ADMIN 이상(@Roles('ADMIN') 게이트 — roles.controller 패턴).
 * AutoMod 규칙은 메시지 모더레이션 정책이라 멤버 전체에 노출하지 않고 관리자만 본다.
 * 변경(POST/PATCH/DELETE)은 per-workspace rate-limit 으로 폭주를 막는다.
 */
@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/automod-rules')
export class AutoModController {
  constructor(
    private readonly automod: AutoModService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // 규칙 변경(생성/수정/삭제)에 per-workspace rate-limit(roles.controller 선례). 60초당 20회.
  private async enforceMutateLimit(workspaceId: string): Promise<void> {
    await this.rateLimit.enforce([
      { key: `automod:mutate:ws:${workspaceId}`, windowSec: 60, max: 20 },
    ]);
  }

  @Roles('ADMIN')
  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    return this.automod.list(member.workspaceId);
  }

  @Roles('ADMIN')
  @Post()
  async create(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(member.workspaceId);
    const parsed = CreateAutoModRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.automod.create(member.workspaceId, user.id, parsed.data);
  }

  @Roles('ADMIN')
  @Patch(':ruleId')
  async update(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(member.workspaceId);
    const parsed = UpdateAutoModRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.automod.update(member.workspaceId, user.id, ruleId, parsed.data);
  }

  @Roles('ADMIN')
  @Delete(':ruleId')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.enforceMutateLimit(member.workspaceId);
    await this.automod.remove(member.workspaceId, user.id, ruleId);
  }
}
