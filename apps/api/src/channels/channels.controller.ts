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
  ChannelRoleOverrideRequestSchema,
  CreateChannelRequestSchema,
  MoveChannelRequestSchema,
  ReorderChannelsRequestSchema,
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

  /**
   * S15 (FR-CH-13): 채널 배치 재정렬 + 재정규화. MANAGE_CHANNEL(=ADMIN) 전용.
   * 클라이언트가 최종 순서(id + categoryId)를 통째로 보내면 서버가 1000 등간격으로
   * 재정규화하고 channels.reordered 를 브로드캐스트한다.
   *
   * 라우트 순서 주의: `positions` 는 `:chid`(ParseUUIDPipe) 보다 먼저 선언해야
   * NestJS 가 'positions' 를 UUID 로 잘못 파싱하지 않는다(pins/history 와 동일 패턴).
   */
  @Roles('ADMIN')
  @Patch('positions')
  async reorder(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = ReorderChannelsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.channels.reorderChannels(m.workspaceId, user.id, parsed.data.items);
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
    // auth/permissions (0x1FF: the 9 channel-override bits ChannelAccessService
    // actually interprets — S15 added BYPASS_SLOWMODE=0x0100), NOT the broader
    // shared-types PERMISSIONS catalog (which includes ADMINISTRATOR + reserved
    // bits the override layer ignores). Bits outside 0x1FF are meaningless to
    // enforcement and would persist as garbage, so reject them. review S12
    // BLOCKER-1 fix.
    const parsed = ChannelMemberOverrideRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const { userId, allowMask, denyMask } = parsed.data;
    // ALL_PERMISSIONS (0x1FF) is contiguous bits 0..8, so a numeric range check
    // is equivalent to a bit-subset check AND avoids JS int32 bitwise wrap
    // (e.g. 2^63 & ~0x1FF would wrap to 0 and slip through; 2^63 > 0x1FF does not).
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

  /**
   * S14 (FR-CH-11): set a ROLE-level permission override on a channel.
   * OWNER/ADMIN only (MANAGE_CHANNEL surface). Body `{ role, allowMask?,
   * denyMask? }`. Masks are bounded against the enforcement bitfield
   * (0xFF) exactly like the USER-override path — bits outside the set are
   * meaningless to enforcement and rejected so they don't persist as
   * garbage. Reuses the S12 range check.
   */
  @Roles('ADMIN')
  @UseGuards(ChannelAccessGuard)
  @AllowArchivedChannel()
  @Post(':chid/roles')
  async addChannelRoleOverride(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = ChannelRoleOverrideRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const { role, allowMask, denyMask } = parsed.data;
    // S12 BLOCKER-1 reuse: bound masks against the enforcement set (0xFF).
    if (allowMask > ALL_PERMISSIONS || denyMask > ALL_PERMISSIONS) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'permission mask has bits outside the channel permission set',
      );
    }
    const result = await this.channels.addChannelRoleOverride(
      m.workspaceId,
      channelId,
      role,
      allowMask,
      denyMask,
    );
    return { override: result };
  }

  /**
   * S14 (FR-CH-07): join a channel. Any workspace member may join a PUBLIC
   * channel (free join → self USER ALLOW override + member_added event).
   * Private channels are invite-only → CHANNEL_PRIVATE_INVITE_ONLY (403).
   * No @Roles gate (members self-serve). No ChannelAccessGuard — a member
   * joining a public channel is allowed even before they hold an override,
   * and the private-channel rejection is enforced in the service.
   */
  @Post(':chid/join')
  @HttpCode(201)
  async join(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.channels.joinChannel(m.workspaceId, channelId, user.id);
  }

  /**
   * S14 (FR-CH-07): leave a channel. Removes the caller's own USER override
   * row; the read state (UserChannelReadState) is PRESERVED so re-joining
   * restores the unread cursor. Non-members get CHANNEL_NOT_MEMBER (409).
   */
  @Post(':chid/leave')
  @HttpCode(200)
  async leave(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.channels.leaveChannel(m.workspaceId, channelId, user.id);
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
    description: string | null;
    position: { toString: () => string };
    slowmodeSeconds: number;
    memberCanPin: boolean;
    fileUploadEnabled: boolean;
    maxFileSizeBytes: bigint | null;
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
      // S13 (FR-CH-10): 설명을 단건 채널 응답에 노출.
      description: c.description,
      position: c.position.toString(),
      // S15 (FR-CH-08): 슬로우모드 간격을 단건 채널 응답에 노출.
      slowmodeSeconds: c.slowmodeSeconds,
      // S51 (FR-PS-05): 핀 권한 채널 오버라이드를 단건 채널 응답에 노출.
      memberCanPin: c.memberCanPin,
      // S55 (FR-CH-18 / FR-AM-20): 첨부 업로드 토글 + 채널별 크기 상한.
      fileUploadEnabled: c.fileUploadEnabled,
      maxFileSizeBytes: c.maxFileSizeBytes === null ? null : Number(c.maxFileSizeBytes),
      isPrivate: c.isPrivate,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
