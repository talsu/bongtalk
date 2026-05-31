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
  ChannelMemberOverrideRequestSchema,
  CreateChannelRequestSchema,
  MoveChannelRequestSchema,
  UpdateChannelRequestSchema,
} from '@qufox/shared-types';
import { ChannelsService } from './channels.service';
import { ChannelAccessGuard } from './guards/channel-access.guard';
import { AllowArchivedChannel } from './decorators/allow-archived.decorator';
import { Roles } from '../workspaces/decorators/roles.decorator';
import { CurrentChannel, CurrentChannelPayload } from './decorators/current-channel.decorator';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../workspaces/guards/workspace-role.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { ALL_PERMISSIONS } from '../auth/permissions';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    // task-012-D: listByWorkspace filters private channels the caller
    // can't see (no 404 information leak — they just disappear).
    return this.channels.listByWorkspace(m.workspaceId, user.id);
  }

  @Roles('ADMIN')
  @Post()
  async create(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = CreateChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const channel = await this.channels.create(m.workspaceId, user.id, parsed.data);
    return this.shape(channel);
  }

  @UseGuards(ChannelAccessGuard)
  @AllowArchivedChannel()
  @Get(':chid')
  async get(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentChannel() channel: CurrentChannelPayload,
  ) {
    // Reads — including reads of archived channels — go through the guard
    // which already injected `req.channel`. No second query needed.
    void channelId;
    return this.channels.toPublicDto(channel.id);
  }

  @Roles('ADMIN')
  @UseGuards(ChannelAccessGuard)
  @Patch(':chid')
  async update(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const ch = await this.channels.update(m.workspaceId, channelId, user.id, parsed.data);
    return this.shape(ch);
  }

  @Roles('OWNER')
  @UseGuards(ChannelAccessGuard)
  @AllowArchivedChannel()
  @Delete(':chid')
  @HttpCode(202)
  async softDelete(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    await this.channels.softDelete(m.workspaceId, channelId, user.id);
    return { channelId };
  }

  @Roles('OWNER')
  @Post(':chid/restore')
  async restore(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const ch = await this.channels.restore(m.workspaceId, channelId, user.id);
    return this.shape(ch);
  }

  /**
   * Task-012-D: add a user-level permission override to a channel.
   * OWNER/ADMIN only. Body `{ userId, allowMask?, denyMask? }`.
   * Creates / updates the override row (unique on channelId +
   * principalType=USER + principalId=userId).
   */
  @Roles('ADMIN')
  @UseGuards(ChannelAccessGuard)
  @AllowArchivedChannel()
  @Post(':chid/members')
  async addChannelMember(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    // S12 BLOCKER (S00 carryover): masks were previously accepted raw, letting
    // an ADMIN inject allowMask:-1 or an undefined bit to escalate. zod first
    // bounds userId (uuid) + masks (non-negative int32 shape). Then we bound
    // against the **enforcement** bitfield — `ALL_PERMISSIONS` from
    // auth/permissions (0xFF: the 8 channel-override bits ChannelAccessService
    // actually interprets), NOT the broader shared-types PERMISSIONS catalog
    // (which includes ADMINISTRATOR + reserved bits the override layer ignores).
    // Bits outside 0xFF are meaningless to enforcement and would persist as
    // garbage, so reject them. review S12 BLOCKER-1 fix.
    const parsed = ChannelMemberOverrideRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const { userId, allowMask, denyMask } = parsed.data;
    // ALL_PERMISSIONS (0xFF) is contiguous bits 0..7, so a numeric range check
    // is equivalent to a bit-subset check AND avoids JS int32 bitwise wrap
    // (e.g. 2^63 & ~0xFF would wrap to 0 and slip through; 2^63 > 0xFF does not).
    if (allowMask > ALL_PERMISSIONS || denyMask > ALL_PERMISSIONS) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'permission mask has bits outside the channel permission set',
      );
    }
    const result = await this.channels.addChannelMemberOverride(
      m.workspaceId,
      channelId,
      userId,
      allowMask,
      denyMask,
    );
    return { override: result };
  }

  @Roles('ADMIN')
  @UseGuards(ChannelAccessGuard)
  @Post(':chid/archive')
  async archive(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const ch = await this.channels.archive(m.workspaceId, channelId, user.id);
    return this.shape(ch);
  }

  @Roles('ADMIN')
  @UseGuards(ChannelAccessGuard)
  @AllowArchivedChannel()
  @Post(':chid/unarchive')
  async unarchive(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const ch = await this.channels.unarchive(m.workspaceId, channelId, user.id);
    return this.shape(ch);
  }

  @Roles('ADMIN')
  @UseGuards(ChannelAccessGuard)
  @Post(':chid/move')
  async move(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = MoveChannelRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const ch = await this.channels.move(m.workspaceId, channelId, user.id, parsed.data);
    return this.shape(ch);
  }

  private shape(c: {
    id: string;
    workspaceId: string | null;
    categoryId: string | null;
    name: string;
    type: string;
    topic: string | null;
    position: { toString: () => string };
    isPrivate: boolean;
    archivedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      categoryId: c.categoryId,
      name: c.name,
      type: c.type,
      topic: c.topic,
      position: c.position.toString(),
      isPrivate: c.isPrivate,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
