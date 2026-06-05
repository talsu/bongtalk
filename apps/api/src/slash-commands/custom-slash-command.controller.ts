import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateCustomCommandRequestSchema,
  SlashCommandItemSchema,
  UpdateCustomCommandRequestSchema,
  type SlashCommandItem,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../workspaces/guards/workspace-role.guard';
import { Roles } from '../workspaces/decorators/roles.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { CustomSlashCommandService } from './custom-slash-command.service';

/**
 * S81c (D15 / FR-SC-09·10) — 워크스페이스 커스텀 슬래시 커맨드 CRUD REST surface.
 *
 * 가드 체인: JwtAuthGuard(전역) → WorkspaceMemberGuard(:wsId, 비멤버 404) →
 * WorkspaceRoleGuard(@Roles('ADMIN') — OWNER/ADMIN 통과, MEMBER 403 WORKSPACE_INSUFFICIENT_ROLE).
 * 즉 CRUD 는 관리자 전용이다(GET 목록은 기존 SlashCommandController 가 멤버에게 빌트인+커스텀 병합).
 *
 * rate 20/min per (workspace, user) — CRUD 는 핫패스가 아니지만 연타/스크립트 abuse 에 상한.
 * 입력 검증은 Zod(Create/Update CustomCommandRequest)로 한다(class-validator 대신 — 슬래시
 * execute 컨트롤러와 동일 패턴). action 은 discriminated union 이라 actionType↔본문 정합을 강제한다.
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, WorkspaceRoleGuard)
@Roles('ADMIN')
@Controller('workspaces/:wsId/slash-commands')
export class CustomSlashCommandController {
  constructor(
    private readonly svc: CustomSlashCommandService,
    private readonly rate: RateLimitService,
  ) {}

  @Post()
  async create(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<SlashCommandItem> {
    await this.enforceRate(wsId, user.id);
    const parsed = CreateCustomCommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const item = await this.svc.create(wsId, user.id, parsed.data);
    // 응답 계약 정합 보증(런타임 가드 — wire 스키마와 1:1).
    return SlashCommandItemSchema.parse(item);
  }

  @Patch(':cmdId')
  async update(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('cmdId', new ParseUUIDPipe()) cmdId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<SlashCommandItem> {
    await this.enforceRate(wsId, user.id);
    const parsed = UpdateCustomCommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const item = await this.svc.update(wsId, cmdId, parsed.data);
    return SlashCommandItemSchema.parse(item);
  }

  @Delete(':cmdId')
  @HttpCode(204)
  async remove(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @Param('cmdId', new ParseUUIDPipe()) cmdId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.enforceRate(wsId, user.id);
    await this.svc.remove(wsId, cmdId);
  }

  private async enforceRate(wsId: string, userId: string): Promise<void> {
    await this.rate.enforce([{ key: `slash:crud:${wsId}:${userId}`, windowSec: 60, max: 20 }]);
  }
}
