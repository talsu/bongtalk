import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ListReactionUsersQuerySchema,
  PERMISSIONS,
  type ListReactionsResponse,
  type ListReactionUsersResponse,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { MessagesService } from '../messages/messages.service';
import { ReactionsService } from './reactions.service';

/**
 * Task-013-B / S39 (D05): POST(toggle) / DELETE / GET reactions. Path is
 * `/messages/:id` at the top level (no workspace/channel prefix) because the
 * message id is globally unique and the channel + workspace are derived
 * inside — keeps the URL stable for the realtime dispatcher.
 */
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class ReactionsController {
  constructor(
    private readonly reactions: ReactionsService,
    private readonly messages: MessagesService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly channelAccess: ChannelAccessByIdGuard,
  ) {}

  /**
   * S40 (FR-RE07): 반응 추가 허용 여부를 카탈로그 ADD_REACTIONS(0x20) 비트로 판정한다.
   *
   * ⚠️ 왜 effective mask 가 아니라 override 행을 직접 보는가:
   * `ChannelAccessService.resolveEffective` 가 돌려주는 effective mask 는 API enum
   * `Permission`(apps/api/src/auth/permissions.ts) 비트 레이아웃으로 fold 된다 —
   * 거기서 비트 0x20 은 MANAGE_CHANNEL 이다(카탈로그의 ADD_REACTIONS=0x20 과 의미가
   * 어긋남 — D12 권한 수렴 대상 carryover). 그래서 effective 의 0x20 비트는
   * "MEMBER 기본은 off, OWNER/ADMIN 기본은 on" 이라, 카탈로그 ADD_REACTIONS 의미와
   * 1:1 로 읽을 수 없다(MEMBER 기본 반응 허용을 깨뜨림).
   *
   * FR-RE07 의 실제 요구는 좁다: "**채널 권한 override 의 REACT 비트가 DENY** 인
   * 유저는 반응 추가 시 403." 즉 기본은 허용이고, ADD_REACTIONS 를 override(USER 또는
   * 본인 ROLE)로 명시 조정한 경우에만 그 결과를 따른다. override allow/deny mask 는
   * 카탈로그 비트로 저장되므로(isValidPermissionMaskNumber 가 ALL_PERMISSIONS 범위로
   * 검증), 여기서 override 행의 allow/deny mask 에 카탈로그 ADD_REACTIONS 비트가
   * 켜져 있는지를 직접 검사한다(requireAnnouncementPostingAllowed 의 override 직접
   * 조회 선례와 동일 패턴).
   *
   * ⚠️ ADR-4 우선순위 fold: 단순 OR 후 (deny&bit)===0 이 아니다. 권위 구현인
   * `PermissionMatrix.fold`(apps/api/src/auth/permissions.ts)와 동일하게 프린시펄
   * 그룹별로 분리해 누적한다 — `base → roleAllow → roleDeny → userAllow → userDeny`
   * 순서(나중 = 우선)다. 이 순서가 보장하는 경계는:
   *   - 역할 DENY 가 역할 ALLOW 를 이긴다(roleDeny 가 roleAllow 뒤에 적용).
   *   - **개인 ALLOW 가 역할 DENY 를 이긴다**(userAllow 가 roleDeny 뒤에 OR — 종전
   *     단순 OR 폴드는 이 경계를 표현하지 못해 (ROLE deny + USER allow) 유저를 잘못
   *     403 했다).
   *   - 개인 DENY 가 최우선(userDeny 가 가장 마지막 AND-NOT).
   * 반응의 base 는 "기본 허용"이라 allowed=true 에서 출발한다(FR-RE07).
   */
  private async canAddReaction(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<{ allowed: boolean; mutedUntil: Date | null }> {
    // 워크스페이스 채널은 호출자 role 로 ROLE 프린시펄 override 를 함께 본다.
    // DM(workspaceId=null)은 role 이 없어 USER 프린시펄만 본다.
    // S62 (FR-RM03): 시스템 역할 리터럴 외에 커스텀 Role UUID override 도 ROLE
    // 프린시펄로 함께 조회한다.
    // S63 fix-forward (perf C-1 = SERIOUS-1/2): 같은 멤버 findUnique 에 mutedUntil 을
    // 편승시켜 별도 isTimedOut DB 왕복을 제거한다. 타임아웃 게이트는 add(INSERT)
    // 분기에서만 적용된다(B-3 — toggle-off 제거는 허용).
    let role: string | null = null;
    let roleUuids: string[] = [];
    let mutedUntil: Date | null = null;
    if (channel.workspaceId !== null) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
        select: { role: true, mutedUntil: true, memberRoles: { select: { roleId: true } } },
      });
      role = member?.role ?? null;
      roleUuids = member?.memberRoles.map((m) => m.roleId) ?? [];
      mutedUntil = member?.mutedUntil ?? null;
    }
    const principals: { principalType: 'USER' | 'ROLE'; principalId: string }[] = [
      { principalType: 'USER', principalId: userId },
    ];
    if (role) principals.push({ principalType: 'ROLE', principalId: role });
    for (const uuid of roleUuids) {
      principals.push({ principalType: 'ROLE', principalId: uuid });
    }
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: { channelId: channel.id, OR: principals },
      select: { principalType: true, principalId: true, allowMask: true, denyMask: true },
    });
    const bit = Number(PERMISSIONS.ADD_REACTIONS); // 카탈로그 0x20

    // 프린시펄 그룹별 mask OR — USER/ROLE 분리(PermissionMatrix.effective 와 동일).
    // S61: allow/denyMask 는 BigInt. ADD_REACTIONS(0x20) 검사는 number 도메인이므로
    // Number 로 좁힌다(override 마스크는 ≤ enforcement 범위라 안전).
    const roleAllow = overrides
      .filter((o) => o.principalType === 'ROLE')
      .reduce((m, o) => m | Number(o.allowMask), 0);
    const roleDeny = overrides
      .filter((o) => o.principalType === 'ROLE')
      .reduce((m, o) => m | Number(o.denyMask), 0);
    const userAllow = overrides
      .filter((o) => o.principalType === 'USER')
      .reduce((m, o) => m | Number(o.allowMask), 0);
    const userDeny = overrides
      .filter((o) => o.principalType === 'USER')
      .reduce((m, o) => m | Number(o.denyMask), 0);

    // ADR-4 우선순위 fold — PermissionMatrix.fold 와 동일 의미(나중 = 우선).
    let allowed = true; // FR-RE07: 반응은 기본 허용
    if (roleAllow & bit) allowed = true;
    if (roleDeny & bit) allowed = false;
    if (userAllow & bit) allowed = true; // userAllow > roleDeny (ADR-4)
    if (userDeny & bit) allowed = false; // userDeny 최우선
    return { allowed, mutedUntil };
  }

  private async resolveChannel(messageId: string) {
    const msg = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null },
      select: {
        id: true,
        channelId: true,
        channel: {
          select: {
            id: true,
            workspaceId: true,
            isPrivate: true,
            archivedAt: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!msg || !msg.channel || msg.channel.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    }
    // S39 fix-forward (security MEDIUM): 보관(archived) 채널은 반응 추가/제거/조회를
    // 모두 막는다. 종전엔 archivedAt 을 SELECT 만 하고 거부하지 않아 attachments
    // 컨트롤러·threads 컨트롤러·ChannelAccessGuard 의 CHANNEL_ARCHIVED 패턴과
    // 어긋나 있었다(보관 채널에 새 반응이 쌓이는 회귀). resolveChannel 한 곳에서
    // 막아 POST / DELETE / GET 이 일관되게 409 로 수렴하게 한다. 존재 leak 을
    // 피하려면 READ ACL 통과 뒤 검사하는 편이 깔끔하지만, archived 는 멤버에게도
    // 동일하게 노출되는 채널 상태라(존재가 이미 가시) 여기서 막아도 leak 이 없다.
    if (msg.channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived — unarchive first');
    }
    return { messageId: msg.id, channel: msg.channel };
  }

  /**
   * S39 (FR-RE01): single-call toggle. 내 반응이 있으면 제거, 없으면 추가하고
   * 항상 200 + 현재 집계({ emoji, count, byMe })를 돌려준다. 클라이언트 api.ts 는
   * 이 단일 POST 만 호출한다(별도 DELETE 분기 불필요 — 자기 토글).
   */
  @Post(':id/reactions')
  @HttpCode(200)
  async toggle(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { emoji: string },
  ): Promise<{ emoji: string; count: number; byMe: boolean }> {
    // Task-013-B rate limit: 60 reactions / minute per user.
    await this.rateLimit.enforce([{ key: `reactions:${user.id}`, windowSec: 60, max: 60 }]);
    const { messageId, channel } = await this.resolveChannel(id);
    // READ bit (not WRITE) — reacting is lighter than posting.
    await this.channelAccess.requireRead(channel, user.id);
    // S40 (FR-RE07): READ 통과 뒤 ADD_REACTIONS override DENY 여부를 미리 판정해
    // 서비스에 넘긴다 — 토글이 INSERT 로 분기할 때만 거부에 쓰인다(remove 는 무관).
    // S63 fix-forward (perf C-1): 위 canAddReaction 의 멤버 findUnique 에 mutedUntil 을
    // 편승시켜 별도 isTimedOut 왕복을 제거한다(SERIOUS-1/2).
    const { allowed: canAdd, mutedUntil } = await this.canAddReaction(channel, user.id);
    // S63 (FR-RM07) + fix-forward (B-3 = MINOR): 워크스페이스 채널 타임아웃 게이트.
    // mutedUntil>now 면 음소거 중이다. FR-RM07 은 "반응 *추가* 차단"이므로 이 플래그를
    // 서비스의 add(INSERT) 분기에만 넘긴다 — toggle-off(자기 반응 제거)는 음소거 중에도
    // 허용한다(종전엔 toggle 진입 자체를 막아 제거까지 과차단했다). DM(workspaceId=null)은
    // 워크스페이스 멤버가 없어 게이트 대상이 아니다. 만료/미설정이면 자동 통과(lazy).
    const isTimedOut =
      channel.workspaceId !== null && mutedUntil != null && mutedUntil.getTime() > Date.now();
    const result = await this.reactions.add(
      messageId,
      channel.id,
      channel.workspaceId,
      user.id,
      body?.emoji ?? '',
      canAdd,
      isTimedOut,
    );
    return result;
  }

  /**
   * S40 (FR-RE05): GET /messages/:id/reactions/:emoji/users — 한 이모지에 반응한
   * **전체** reactor 목록을 cursor 페이지네이션(기본 50/최대 100)으로 반환한다.
   * FR-RE04 의 GET reactions 가 이모지당 ≤5명만 싣는 것과 달리, 칩을 눌렀을 때
   * 전원을 무한 스크롤로 펼치기 위한 엔드포인트다. 채널 READ ACL 적용.
   *
   * ⚠️ 라우트 순서: 이 GET 은 `:emoji/users` 정적 세그먼트를 포함하므로
   * `GET :id/reactions`(세그먼트 수가 다름)와 충돌하지 않는다 — 더 구체적인 경로를
   * 위에 둔다.
   */
  @Get(':id/reactions/:emoji/users')
  async listEmojiUsers(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('emoji') emoji: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: Record<string, unknown>,
  ): Promise<ListReactionUsersResponse> {
    // S40 fix-forward (HIGH): toggle/remove/clear 와 정합되게 reactor 목록 조회에도
    // rate-limit 을 건다(종전 누락). 읽기 전용 GET 이라 토글(60/min)보다 넉넉한
    // 보수적 한도(120/min)로 무한 스크롤 페이지 당김을 허용하면서 남용을 막는다.
    await this.rateLimit.enforce([{ key: `reactions:users:${user.id}`, windowSec: 60, max: 120 }]);
    const parsed = ListReactionUsersQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid reactor list query');
    }
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    return this.reactions.listEmojiUsers(
      messageId,
      decodeURIComponent(emoji),
      parsed.data.limit,
      parsed.data.cursor,
    );
  }

  /**
   * S39 (FR-RE04): GET /messages/:id/reactions — emoji별 { emoji, count,
   * users:[…최대 5명] } 집계. 채널 READ ACL 적용.
   */
  @Get(':id/reactions')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ListReactionsResponse> {
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    const reactions = await this.messages.aggregateReactionDetails(messageId);
    return { reactions };
  }

  /**
   * S40 (FR-RE08): DELETE /messages/:id/reactions/:emoji/users/:userId — OWNER/ADMIN
   * 이 특정 사용자의 한 이모지 반응을 제거한다. actor === target 이면 자기 반응
   * 제거(항상 허용), 타인 제거는 OWNER/ADMIN 만(MEMBER 는 403). 채널 READ ACL 적용.
   * 가장 구체적인 DELETE 경로라 위에 둔다(라우트 충돌 방지).
   */
  @Delete(':id/reactions/:emoji/users/:userId')
  @HttpCode(204)
  async removeByActor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('emoji') emoji: string,
    @Param('userId', new ParseUUIDPipe()) targetUserId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([{ key: `reactions:${user.id}`, windowSec: 60, max: 60 }]);
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    await this.reactions.removeByActor(
      messageId,
      channel.id,
      channel.workspaceId,
      user.id,
      targetUserId,
      decodeURIComponent(emoji),
    );
  }

  /**
   * S39 (FR-RE08): DELETE /messages/:id/reactions/:emoji — 자기 반응 제거(toggle off
   * 와 동치). no-op 도 204. 채널 READ ACL 적용.
   */
  @Delete(':id/reactions/:emoji')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('emoji') emoji: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([{ key: `reactions:${user.id}`, windowSec: 60, max: 60 }]);
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    await this.reactions.remove(
      messageId,
      channel.id,
      channel.workspaceId,
      user.id,
      decodeURIComponent(emoji),
    );
  }

  /**
   * S40 (FR-RE09): DELETE /messages/:id/reactions — 메시지의 **모든** 반응을 일괄
   * 삭제한다. OWNER/ADMIN 전용(MEMBER/DM 비-OWNER 는 403). 204 + reaction:cleared
   * 이벤트 fanout. 채널 READ ACL 적용.
   *
   * ⚠️ 라우트 순서/충돌: 이 DELETE 는 `:emoji` 가 없는 2-세그먼트 경로
   * (`:id/reactions`)이고, FR-RE08 의 자기 제거는 3-세그먼트(`:id/reactions/:emoji`),
   * 타인 제거는 5-세그먼트(`:id/reactions/:emoji/users/:userId`)다. 세그먼트 수가
   * 모두 달라 Express 매칭상 충돌하지 않는다 — 가장 일반적인 본 경로를 맨 아래 둔다.
   */
  @Delete(':id/reactions')
  @HttpCode(204)
  async clearAll(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([{ key: `reactions:${user.id}`, windowSec: 60, max: 60 }]);
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    // FR-RE09: OWNER/ADMIN 게이트. DM(workspaceId=null)은 워크스페이스 role 이 없어
    // 일괄 삭제 불가(403). 워크스페이스 채널은 role 조회로 판정한다.
    if (channel.workspaceId === null) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'bulk reaction clear is owner/admin only');
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId: user.id } },
      select: { role: true },
    });
    if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'bulk reaction clear is owner/admin only');
    }
    await this.reactions.clearAll(messageId, channel.id, channel.workspaceId, user.id);
  }
}
