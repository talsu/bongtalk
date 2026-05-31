import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DirectMessagesService, type DmListItem } from './direct-messages.service';
import { CreateDmDto } from './dto/create-dm.dto';
import { CreateGroupDmDto } from './dto/create-group-dm.dto';

/**
 * task-033-B: global DM endpoints under /me/dms. Same service as the
 * original workspace-scoped DM path but with workspaceId=null
 * (friend-gated, no workspace). task-037-A removed the old
 * workspace-scoped controller — this is the sole DM surface now.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/dms')
export class GlobalDmController {
  constructor(private readonly svc: DirectMessagesService) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(50)) limitRaw: string | number,
  ): Promise<{ items: DmListItem[] }> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    const items = await this.svc.list(null, user.id, limit || 50);
    return { items };
  }

  @Get('by-user/:userId')
  async findByUser(
    @CurrentUser() user: CurrentUserPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<{ channelId: string | null }> {
    const hit = await this.svc.findByUser(null, user.id, userId);
    return { channelId: hit?.channelId ?? null };
  }

  @Post()
  async createOrGet(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: CreateDmDto,
  ): Promise<{ channelId: string; created: boolean }> {
    return this.svc.createOrGetGlobal(user.id, body.userId);
  }

  /**
   * task-045 iter5: 그룹 DM (3+) 생성 또는 같은 멤버 set 의 기존
   * 채널 반환. S16 (FR-DM-02): 본인 제외 2-19 명 (총 3-20). 초과 시
   * 422 (DM_GROUP_CAP_EXCEEDED).
   *
   *   POST /me/dms/groups
   *   Body: { memberIds: string[], workspaceId?: string }
   *
   * workspaceId omitted → global DM. S16 (BLOCKER fix-forward): 전역 그룹은
   * 각 memberId 마다 친구(ACCEPTED) 게이트를 강제한다(서비스 레이어). 형식
   * 검증(배열·UUID)은 CreateGroupDmDto + ValidationPipe 가 담당한다.
   */
  @Post('groups')
  async createGroupDm(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: CreateGroupDmDto,
  ): Promise<{ channelId: string; created: boolean; memberIds: string[] }> {
    const workspaceId =
      typeof body.workspaceId === 'string' && body.workspaceId.length > 0 ? body.workspaceId : null;
    return this.svc.createGroupDm({ workspaceId, meId: user.id, memberIds: body.memberIds });
  }

  /**
   * task-045 iter8: 사용자가 멤버인 group DM 목록.
   * 1:1 DM 은 GET /me/dms 가 처리. group 만 별도 listing 으로 분리해
   * UI 가 두 영역을 섞지 않고 표시 가능.
   *
   *   GET /me/dms/groups
   *   Response: { items: [{ channelId, memberIds, participants(≤5),
   *               lastMessageAt, lastMessagePreview, createdAt }] }
   */
  @Get('groups')
  async listGroups(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(50)) limitRaw: string | number,
  ): Promise<{
    items: Array<{
      channelId: string;
      memberIds: string[];
      participants: Array<{ userId: string; username: string }>;
      lastMessageAt: string | null;
      lastMessagePreview: string | null;
      createdAt: string;
    }>;
  }> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    const items = await this.svc.listGroups(null, user.id, limit || 50);
    return { items };
  }

  /**
   * task-046 iter0 (HIGH-2 carry-over): GDM 멤버 username/customStatus
   * 조회. deep-link / refresh 시 sidebar list 미경유여도 헤더 표시 가능.
   *
   *   GET /me/dms/groups/:gdmId/members
   *
   * 호출자가 GDM 멤버일 때만 200. 그 외엔 404 (존재 leak 방지).
   */
  @Get('groups/:gdmId/members')
  async getGroupMembers(
    @CurrentUser() user: CurrentUserPayload,
    @Param('gdmId', new ParseUUIDPipe()) gdmId: string,
  ): Promise<{
    items: Array<{ userId: string; username: string; customStatus: string | null }>;
  }> {
    const items = await this.svc.getGroupMembers(user.id, gdmId);
    return { items };
  }
}
