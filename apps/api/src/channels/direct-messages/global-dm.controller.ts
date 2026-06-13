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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DirectMessagesService, type DmListItem } from './direct-messages.service';
import { MutesService } from '../../notifications/mutes/mutes.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { CreateDmDto } from './dto/create-dm.dto';
import { CreateGroupDmDto } from './dto/create-group-dm.dto';
import { AddParticipantsDto } from './dto/add-participants.dto';
import { RenameGroupDmDto } from './dto/rename-group-dm.dto';
import { SetDmVisibilityDto } from './dto/set-dm-visibility.dto';
import { SetDmMuteDto } from './dto/set-dm-mute.dto';

// S20 (FR-DM-06): 그룹 DM 아이콘 multipart 수신 한도. FileInterceptor 의 multer
// limits 로 4MB 를 1차 거부하고, 서비스가 magic-byte/mime/크기를 2차 검증한다.
const DM_ICON_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * task-033-B: global DM endpoints under /me/dms. Same service as the
 * original workspace-scoped DM path but with workspaceId=null
 * (friend-gated, no workspace). task-037-A removed the old
 * workspace-scoped controller — this is the sole DM surface now.
 */
/**
 * S20 (FR-DM-06): multer 가 FileInterceptor 로 채워주는 업로드 파일 형태.
 * `@types/multer` 를 추가하지 않고도 strict + no-any 를 만족하도록 필요한 필드만
 * 좁게 선언한다(buffer/mimetype/originalname/size). multer memory storage 라
 * `buffer` 는 항상 존재한다.
 */
interface UploadedMultipartFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

// S102 (FR-DM rate-limit · carryover): DM 채널 생성/관리 mutation 의 per-user
// sliding-window 한도. 친구(ACCEPTED) 게이트가 1차 방어이므로 이 한도는 burst
// 스팸·rapid create/대량 참가자추가에 대한 defense-in-depth 다(정상 사용·테스트
// 무영향 수준으로 관대하게 설정). createOrGet 은 DM 열기마다 호출되는 idempotent
// 엔드포인트라 브라우징을 막지 않도록 특히 관대하다. 키 컨벤션 `dm:{action}:u:{id}`
// (메트릭 라벨=앞 2세그먼트 `dm:{action}` 로 카디널리티 bound).
const DM_CREATE_WINDOW_SEC = 60;
const DM_CREATE_MAX = 60; // 1:1 DM 열기/생성 (idempotent·브라우징 허용)
const DM_GROUP_CREATE_MAX = 20; // 그룹 DM 생성 (combinatorial 스팸 차단)
const DM_ADD_PARTICIPANTS_MAX = 30; // 그룹 참가자 추가
const DM_RENAME_MAX = 10; // 그룹 이름 변경 (S102 보안 리뷰 MED-2: write + 전원 WS fanout)
// 072 백로그 S-A (N1 적대 리뷰 defense-in-depth): visibility/mute/leave/members 라우트 rate-limit.
// 전부 멤버 게이트라 cross-tenant 영향은 없으나, write+upsert/serializable tx 부하 상한을 둔다.
const DM_VISIBILITY_MAX = 30; // 숨김/표시 토글 (USER override hiddenAt updateMany)
const DM_MUTE_MAX = 30; // 뮤트/기간 변경 (UserChannelMute upsert)
const DM_LEAVE_MAX = 20; // 그룹 나가기 (Serializable tx + owner 승계 + fanout)
const DM_GET_MEMBERS_MAX = 120; // 그룹 멤버 조회 (read·useDmGroupMembers 30s staleTime 빈번)

@UseGuards(JwtAuthGuard)
@Controller('me/dms')
export class GlobalDmController {
  constructor(
    private readonly svc: DirectMessagesService,
    private readonly mutes: MutesService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(50)) limitRaw: string | number,
    // S20 (FR-DM-04): 검색어. group displayName/slug OR 참여자 username ILIKE 매칭.
    @Query('q') q?: string,
  ): Promise<{ items: DmListItem[] }> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    const items = await this.svc.list(null, user.id, limit || 50, q);
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
    await this.rate.enforce([
      { key: `dm:create:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_CREATE_MAX },
    ]);
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
    await this.rate.enforce([
      { key: `dm:group:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_GROUP_CREATE_MAX },
    ]);
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
    // S20 (FR-DM-04): 검색어. group displayName/slug OR 참여자 username ILIKE 매칭.
    @Query('q') q?: string,
  ): Promise<{
    items: Array<{
      channelId: string;
      memberIds: string[];
      participants: Array<{ userId: string; username: string }>;
      // S20 (FR-DM-05/06): 사용자 지정 표시명 + 아이콘 키/URL.
      displayName: string | null;
      iconUrl: string | null;
      lastMessageAt: string | null;
      lastMessagePreview: string | null;
      createdAt: string;
    }>;
  }> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    const items = await this.svc.listGroups(null, user.id, limit || 50, q);
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
    // 072 백로그 S-A: 조회지만 useDmGroupMembers 가 30s staleTime 으로 빈번 호출 → 관대 상한.
    await this.rate.enforce([
      { key: `dm:members:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_GET_MEMBERS_MAX },
    ]);
    const items = await this.svc.getGroupMembers(user.id, gdmId);
    return { items };
  }

  /**
   * S19 (FR-DM-07): 그룹 DM 멤버 추가. owner 만 가능. cap(본인 포함 ≤20) 초과 시
   * 422 DM_GROUP_CAP_EXCEEDED, 한 명이라도 게이트 실패 시 전체 롤백(부분 추가 금지).
   *
   *   POST /me/dms/:channelId/participants { userIds: string[] }
   */
  @Post(':channelId/participants')
  async addParticipants(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Body() body: AddParticipantsDto,
  ): Promise<{ channelId: string; addedUserIds: string[] }> {
    await this.rate.enforce([
      {
        key: `dm:participant:u:${user.id}`,
        windowSec: DM_CREATE_WINDOW_SEC,
        max: DM_ADD_PARTICIPANTS_MAX,
      },
    ]);
    return this.svc.addParticipants({ meId: user.id, channelId, userIds: body.userIds });
  }

  /**
   * S19 (FR-DM-09): 그룹 DM 나가기(본인). owner 가 나가면 잔여 멤버 중 joinedAt
   * 최古로 자동 승계, 마지막 멤버면 채널 soft-delete. 204.
   *
   *   DELETE /me/dms/:channelId/participants/me
   *
   * ★ 라우트 등록 순서: `/participants/me` 를 `/participants/:userId` 보다 **먼저**
   * 선언한다 — Nest 라우터가 'me' 를 :userId 파라미터로 매칭하는 충돌을 막는다.
   */
  @Delete(':channelId/participants/me')
  @HttpCode(204)
  async leaveGroup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
  ): Promise<void> {
    // 072 백로그 S-A: Serializable tx + owner 승계 + fanout 부하 상한.
    await this.rate.enforce([
      { key: `dm:leave:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_LEAVE_MAX },
    ]);
    await this.svc.leaveGroup({ meId: user.id, channelId });
  }

  /**
   * S19 (FR-DM-08): 그룹 DM 멤버 강퇴. owner 만(else 403), 1:1 DM 은 항상 403,
   * owner 자기-강퇴는 403(leave 경로 유도). 204.
   *
   *   DELETE /me/dms/:channelId/participants/:userId
   */
  @Delete(':channelId/participants/:userId')
  @HttpCode(204)
  async kickParticipant(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    await this.svc.kickParticipant({ meId: user.id, channelId, targetUserId: userId });
  }

  /**
   * S20 (FR-DM-05): 그룹 DM 이름 변경. group(`gdm:%`) 만, 현역 멤버 허용. slug
   * `Channel.name` 은 불변 — `Channel.displayName` 만 세팅한다. 변경 즉시 참여자
   * 전원에게 dm:group_updated(displayName) emit.
   *
   *   PATCH /me/dms/:channelId { name }
   */
  @Patch(':channelId')
  async renameGroup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Body() body: RenameGroupDmDto,
  ): Promise<{ channelId: string; displayName: string }> {
    // S102 보안 리뷰 MED-2: 이름 변경은 DB write + 참여자 전원 dm:group_updated
    // fanout 을 유발하므로 반복 호출 abuse 를 막는다(현역 멤버 누구나 호출 가능).
    await this.rate.enforce([
      { key: `dm:rename:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_RENAME_MAX },
    ]);
    return this.svc.renameGroup({ meId: user.id, channelId, name: body.name });
  }

  /**
   * S20 (FR-DM-06): 그룹 DM 아이콘 업로드. multipart/form-data, field 명 `file`.
   * 4MB / JPEG·PNG·GIF·WebP, validate-magic-bytes 로 위조 차단, MinIO 저장 후
   * `Channel.iconUrl` 세팅 + dm:group_updated(iconUrl) emit. group-only, 현역 멤버.
   *
   *   POST /me/dms/:channelId/icon  (form field: file)
   */
  @Post(':channelId/icon')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: DM_ICON_UPLOAD_MAX_BYTES, files: 1 } }),
  )
  async setGroupIcon(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @UploadedFile() file: UploadedMultipartFile | undefined,
  ): Promise<{ channelId: string; iconUrl: string }> {
    if (!file || !file.buffer || file.buffer.byteLength === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'icon file is required (field: file)');
    }
    return this.svc.setGroupIcon({
      meId: user.id,
      channelId,
      bytes: file.buffer,
      mime: file.mimetype,
      originalName: file.originalname,
    });
  }

  /**
   * S20 (FR-DM-06): 그룹 DM 아이콘 삭제. MinIO object 정리 + iconUrl=NULL +
   * dm:group_updated(iconUrl=null) emit. group-only, 현역 멤버. 멱등(아이콘 없으면 204).
   *
   *   DELETE /me/dms/:channelId/icon
   */
  @Delete(':channelId/icon')
  @HttpCode(204)
  async removeGroupIcon(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
  ): Promise<void> {
    await this.svc.removeGroupIcon({ meId: user.id, channelId });
  }

  /**
   * S20 (FR-DM-10): DM 숨기기/표시 토글. 요청자 USER override 의 hiddenAt 을 세팅
   * (HIDDEN=now, VISIBLE=NULL). GET /me/dms·/me/dms/groups 가 숨김 DM 을 제외한다.
   * 상대방의 새 메시지가 도착하면 send 경로가 수신자 hiddenAt 을 자동 복원한다.
   *
   *   PATCH /me/dms/:channelId/visibility { visibility: 'HIDDEN'|'VISIBLE' }
   */
  @Patch(':channelId/visibility')
  async setVisibility(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Body() body: SetDmVisibilityDto,
  ): Promise<{ channelId: string; visibility: 'HIDDEN' | 'VISIBLE' }> {
    // 072 백로그 S-A: write(USER override hiddenAt updateMany) 부하 상한.
    await this.rate.enforce([
      { key: `dm:visibility:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_VISIBILITY_MAX },
    ]);
    return this.svc.setVisibility({ meId: user.id, channelId, visibility: body.visibility });
  }

  /**
   * S20 (FR-DM-11): DM 뮤트. 기존 UserChannelMute upsert(task-045) 를 DM 라우트로
   * 배선한다. mutedUntil null = 무기한, 미래 시각 = 그때까지(만료는 query-time 필터).
   * @직접멘션 배지는 기존 mute>pref 게이트에서 유지된다(send 경로의 mute 필터는
   * mention.received outbox 만 스킵하므로 채널 unread 배지는 영향 없음).
   *
   * S20 (BLOCKER fix-forward, IDOR): 요청자가 이 DM 의 현역 멤버인지 먼저 검증한다.
   * MutesService.setMute 자체는 채널 access 를 가드하지 않으므로(설계상 호출자 책임),
   * 게이트가 없으면 임의 channelId 에 UserChannelMute 행이 upsert 되거나(FK 위반
   * P2003 → 500) 채널 존재가 열거된다. 비멤버·부재·비-DIRECT 는 404 로 거부한다.
   *
   *   PATCH /me/dms/:channelId/mute { mutedUntil: ISO8601 | null }
   */
  @Patch(':channelId/mute')
  async setMute(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Body() body: SetDmMuteDto,
  ): Promise<{ channelId: string; mutedUntil: string | null }> {
    await this.svc.assertDmMember(user.id, channelId);
    // 072 백로그 S-A: UserChannelMute upsert 부하 상한(멤버 게이트 직후).
    await this.rate.enforce([
      { key: `dm:mute:u:${user.id}`, windowSec: DM_CREATE_WINDOW_SEC, max: DM_MUTE_MAX },
    ]);
    const row = await this.mutes.setMute({
      userId: user.id,
      channelId,
      mutedUntil: body.mutedUntil ? new Date(body.mutedUntil) : null,
    });
    return {
      channelId: row.channelId,
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
    };
  }
}
