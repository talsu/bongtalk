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
  AssignSidebarChannelRequestSchema,
  CreateSidebarSectionRequestSchema,
  MoveSidebarChannelRequestSchema,
  MoveSidebarSectionRequestSchema,
  UpdateSidebarSectionRequestSchema,
} from '@qufox/shared-types';
import { Prisma } from '@prisma/client';
import { SidebarSectionsService, SectionRow } from './sidebar-sections.service';
import { WorkspaceMemberGuard } from '../../workspaces/guards/workspace-member.guard';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../../workspaces/decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S85 (FR-CH-16): 사이드바 개인 섹션 endpoints (워크스페이스 스코프).
 *
 * 권한 모델: 워크스페이스 멤버(WorkspaceMemberGuard)면 누구나 본인 사이드바 섹션을
 * 만들고 정리한다 — 전부 개인 상태라 ADMIN 권한 불요(즐겨찾기와 동일). @CurrentUser 가
 * userId 스코프를, @CurrentMember 가 workspaceId 를 제공한다. 섹션/할당은 타인 미노출.
 *
 * 라우트는 `workspaces/:id/sidebar-sections` — :id 가 워크스페이스 id 다.
 * mutate(생성/수정/삭제/할당/재정렬)는 per-(user, workspace) rate-limit 로 폭주를 막는다
 * (roles.controller enforceMutateLimit 패턴).
 */
@UseGuards(WorkspaceMemberGuard)
@Controller('workspaces/:id/sidebar-sections')
export class SidebarSectionsController {
  constructor(
    private readonly sections: SidebarSectionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async enforceMutateLimit(userId: string, workspaceId: string): Promise<void> {
    await this.rateLimit.enforce([
      { key: `sidebar-section:mutate:ws:${workspaceId}:user:${userId}`, windowSec: 60, max: 40 },
    ]);
  }

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    const rows = await this.sections.list(user.id, member.workspaceId);
    return { sections: rows.map(shapeSection) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    const parsed = CreateSidebarSectionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const row = await this.sections.create(user.id, member.workspaceId, parsed.data);
    return shapeSection(row);
  }

  @Patch(':sectionId')
  async update(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    const parsed = UpdateSidebarSectionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const row = await this.sections.update(user.id, member.workspaceId, sectionId, parsed.data);
    return shapeSection(row);
  }

  @Delete(':sectionId')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    await this.sections.remove(user.id, member.workspaceId, sectionId);
  }

  @Patch(':sectionId/position')
  async moveSection(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    const parsed = MoveSidebarSectionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const row = await this.sections.moveSection(
      user.id,
      member.workspaceId,
      sectionId,
      parsed.data,
    );
    return shapeSection(row);
  }

  @Post(':sectionId/channels')
  @HttpCode(200)
  async assignChannel(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    const parsed = AssignSidebarChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const row = await this.sections.assignChannel(
      user.id,
      member.workspaceId,
      sectionId,
      parsed.data.channelId,
    );
    return shapeSection(row);
  }

  @Delete(':sectionId/channels/:channelId')
  @HttpCode(200)
  async unassignChannel(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('sectionId', new ParseUUIDPipe()) sectionId: string,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    const row = await this.sections.unassignChannel(
      user.id,
      member.workspaceId,
      sectionId,
      channelId,
    );
    return shapeSection(row);
  }

  @Patch('channels/:channelId/position')
  async moveChannel(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(user.id, member.workspaceId);
    const parsed = MoveSidebarChannelRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const row = await this.sections.moveChannel(
      user.id,
      member.workspaceId,
      channelId,
      parsed.data,
    );
    return shapeSection(row);
  }
}

/** SectionRow → wire DTO. position 은 Decimal → string, createdAt → ISO. */
function shapeSection(row: SectionRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    emoji: row.emoji,
    sortMode: row.sortMode,
    position: (row.position as Prisma.Decimal).toString(),
    channelIds: row.channelIds,
    createdAt: row.createdAt.toISOString(),
  };
}
