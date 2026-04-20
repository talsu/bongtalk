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
  CreateCategoryRequestSchema,
  MoveCategoryRequestSchema,
  UpdateCategoryRequestSchema,
} from '@qufox/shared-types';
import { CategoriesService } from './categories.service';
import { Roles } from '../../workspaces/decorators/roles.decorator';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../../workspaces/decorators/current-member.decorator';
import { WorkspaceMemberGuard } from '../../workspaces/guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../../workspaces/guards/workspace-role.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Roles('ADMIN')
  @Post()
  async create(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = CreateCategoryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const cat = await this.categories.create(m.workspaceId, user.id, parsed.data);
    return this.shape(cat);
  }

  @Roles('ADMIN')
  @Patch(':catid')
  async update(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('catid', new ParseUUIDPipe()) categoryId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateCategoryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const cat = await this.categories.update(m.workspaceId, categoryId, user.id, parsed.data);
    return this.shape(cat);
  }

  @Roles('ADMIN')
  @Delete(':catid')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('catid', new ParseUUIDPipe()) categoryId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.categories.remove(m.workspaceId, categoryId, user.id);
  }

  @Roles('ADMIN')
  @Post(':catid/move')
  async move(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('catid', new ParseUUIDPipe()) categoryId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = MoveCategoryRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const cat = await this.categories.move(m.workspaceId, categoryId, user.id, parsed.data);
    return this.shape(cat);
  }

  private shape(c: {
    id: string;
    workspaceId: string;
    name: string;
    description: string | null;
    position: { toString: () => string };
    createdAt: Date;
  }) {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      name: c.name,
      description: c.description,
      position: c.position.toString(),
      createdAt: c.createdAt.toISOString(),
    };
  }
}
