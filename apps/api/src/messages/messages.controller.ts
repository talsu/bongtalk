import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ListMessagesQuerySchema,
  SendMessageRequestSchema,
  UpdateMessageRequestSchema,
  BulkDeleteRequestSchema,
  ReportMessageRequestSchema,
  type BulkDeleteResponse,
  type ListEditHistoryResponse,
} from '@qufox/shared-types';
import { ModerationReportService } from '../workspaces/moderation/moderation-report.service';
import { MessagesService } from './messages.service';
import { MessageAuthorGuard } from './guards/message-author.guard';
import { CurrentMessage, CurrentMessagePayload } from './decorators/current-message.decorator';
import { ChannelAccessGuard } from '../channels/guards/channel-access.guard';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { Permission } from '../auth/permissions';
import { SlowmodeService } from '../channels/slowmode/slowmode.service';
import {
  CurrentChannel,
  CurrentChannelPayload,
} from '../channels/decorators/current-channel.decorator';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { validateIdempotencyKey } from './idempotency';
import { hasBroadMentionSignal } from './mentions/mention-extractor';

// S61: 시스템 역할 5단계 확장 — 3값 union 을 5값 전체로 넓힌다.
type WorkspaceRoleStr = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';

/**
 * Messages live under `/workspaces/:id/channels/:chid/messages`. The full
 * guard chain is:
 *   JwtAuthGuard (global) → WorkspaceMemberGuard (:id) → ChannelAccessGuard (:chid)
 * then PATCH adds MessageAuthorGuard and DELETE handles author-or-admin in
 * the service layer.
 *
 * Idempotency (POST only):
 *   - client sends `Idempotency-Key: <uuid>` (optional — sending the same
 *     request twice WITHOUT a key creates two rows, which matches the zero-key
 *     semantics of RFC draft-ietf-httpapi-idempotency-key-header)
 *   - server returns `Idempotency-Replayed: true` when the row already existed
 *   - mismatched content under the same key ⇒ 409 IDEMPOTENCY_KEY_REUSE_CONFLICT
 */
@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid/messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly rate: RateLimitService,
    // S13 (FR-CH-19): ANNOUNCEMENT 게시 게이트(CHANNEL_POSTING_RESTRICTED).
    private readonly channelAccess: ChannelAccessService,
    // S15 (FR-CH-08): 채널 슬로우모드 게이트.
    private readonly slowmode: SlowmodeService,
    // S64 (FR-RM11): 메시지 신고 생성(채널 ACL 가드가 필요해 message-scope 에 둔다).
    private readonly reports: ModerationReportService,
  ) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    // S03 (FR-MSG-21): `lastReadMessageId` must not be smuggled in as a
    // pagination cursor. Surface it as a cursor error (400) BEFORE the generic
    // schema parse so the message is specific. before/after/around must stay
    // opaque base64url(JSON{id,createdAt}) tokens.
    if (rawQuery.lastReadMessageId !== undefined) {
      throw new DomainError(
        ErrorCode.MESSAGE_CURSOR_INVALID,
        'lastReadMessageId is a read-state cursor and cannot be used for pagination — use the opaque before/after token',
      );
    }
    const parsed = ListMessagesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    if (parsed.data.includeDeleted && !this.isAdminOrOwner(m.role)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'ADMIN or OWNER required to list deleted messages',
      );
    }
    await this.rate.enforce([{ key: `msg:get:u:${user.id}`, windowSec: 60, max: 600 }]);
    // S17 (FR-DM-17/18 / FR-TH-19): DM(DIRECT) 채널일 때만 가시성 하한선 필터를 적용한다
    // (visibleFrom 은 DM 멤버십 override 에만 존재 — 일반 채널은 null 로 무영향).
    //
    // S75 (D14 / FR-PS-14 · C1): 차단 사용자 마스킹은 DM 뿐 아니라 **워크스페이스 채널
    // 메시지 리스트에도** 동일 적용한다. loadBlockedUserIds(내가 차단한 상대) 를 모든 채널
    // 타입에서 로드해 maskBlockedAuthors 로 본문/멘션/임베드를 placeholder 로 가린다(단방향
    // 마스킹 — 내가 차단한 사람의 메시지만 *나에게* 가려진다, Discord 의미와 일관). 차단이
    // 없으면(0건) maskBlockedAuthors 가 즉시 no-op 이라 일반 멤버 hot-path 비용은 SELECT 1회뿐.
    const isDirect = channel?.type === 'DIRECT';
    const [visibleFrom, blockedIds] = await Promise.all([
      isDirect ? this.messages.resolveDmVisibleFrom(channelId, user.id) : Promise.resolve(null),
      this.messages.loadBlockedUserIds(user.id),
    ]);
    const result = await this.messages.list({
      channelId,
      before: parsed.data.before,
      after: parsed.data.after,
      around: parsed.data.around,
      limit: parsed.data.limit,
      includeDeleted: parsed.data.includeDeleted ?? false,
      visibleFrom,
    });
    // task-013-B: reactions join is one extra round-trip per page, not per
    // message. Empty page → skip the query entirely.
    const ids = result.items.map((r) => r.id);
    const [reactionMap, threadMap, attachmentMap, broadcastExcerptMap, embedMap] =
      await Promise.all([
        this.messages.aggregateReactions(ids, user.id),
        // task-014-B: thread summary join, same one-per-page round trip.
        // S36 (FR-TH-04): viewer 의 ThreadReadState 를 배치 조인해 per-viewer 미읽
        // 여부(threadMeta.hasUnread)를 같은 쿼리에서 산정한다(N+1 없음).
        this.messages.aggregateThreadSummaries(ids, user.id),
        // Inline attachments projection — same batched pattern so a page
        // of 50 messages costs one reactions / one thread / one attachment
        // query regardless of how many of them have media.
        this.messages.aggregateAttachments(ids),
        // S35 (FR-TH-06): broadcast 행의 루트 excerpt 를 페이지당 1쿼리로 모은다
        // (broadcast 행이 없으면 추가 쿼리 없음 — 내부 early return).
        this.messages.aggregateBroadcastExcerpts(result.items),
        // S60 (FR-RC07/08): unfurl embed 를 페이지당 1쿼리로 모은다(suppressedAt IS NULL).
        this.messages.aggregateEmbeds(ids),
      ]);
    const dtos = result.items.map((r) =>
      this.messages.toDto(
        r,
        reactionMap.get(r.id) ?? [],
        threadMap.get(r.id) ?? null,
        attachmentMap.get(r.id) ?? [],
        broadcastExcerptMap.get(r.id)?.excerpt ?? null,
        embedMap.get(r.id) ?? [],
      ),
    );
    // S75 fix-forward (F2): broadcast 행의 루트 작성자 맵을 maskBlockedAuthors 에
    // 넘겨, 차단 작성자의 루트 본문이 parentExcerpt 로 채널 타임라인에 누출되지
    // 않도록 한다(행 author 가 비차단인 broadcast 의 excerpt 마스킹).
    const rootAuthorByMessageId = new Map(
      [...broadcastExcerptMap].map(([id, v]) => [id, v.rootAuthorId] as const),
    );
    return {
      items: this.messages.maskBlockedAuthors(dtos, blockedIds, rootAuthorByMessageId),
      pageInfo: {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        prevCursor: result.prevCursor,
      },
    };
  }

  /**
   * task-044-iter2: 채널의 pinned 메시지 목록.
   * 정렬 pinnedAt DESC, cap 50 까지. soft-deleted 자동 제외.
   * 모든 워크스페이스 멤버가 조회 가능 (Discord/Slack 동일).
   *
   * 주의: 라우트 순서가 중요합니다 — `Get('pins')` 가
   * `Get(':msgId')` 보다 먼저 선언되어야 NestJS 가 'pins' 을 UUID 로
   * 잘못 파싱하지 않습니다.
   */
  @Get('pins')
  async listPins(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const result = await this.messages.listPins(channelId);
    const ids = result.items.map((r) => r.id);
    const [reactionMap, attachmentMap] = await Promise.all([
      this.messages.aggregateReactions(ids, user.id),
      this.messages.aggregateAttachments(ids),
    ]);
    return {
      items: result.items.map((r) =>
        this.messages.toDto(r, reactionMap.get(r.id) ?? [], null, attachmentMap.get(r.id) ?? []),
      ),
      cap: result.cap,
      used: result.used,
    };
  }

  /**
   * S05 (FR-RC16): 메시지 편집 이력. 작성자 본인 또는 MANAGE_MESSAGES
   * 권한자(여기서는 보수적으로 OWNER/ADMIN — 채널 권한 마스크 헬퍼가
   * messages 모듈에 미배선이라 carryover)만 전체 이력을 조회합니다. 일반
   * 멤버(비작성자)는 403(MESSAGE_NOT_AUTHOR). 반환은 version desc, 최대 10개.
   * (FR-MSG-08 의 이력 팝오버 UI 는 S06 에서 이 엔드포인트를 소비.)
   *
   * security HIGH-01: `:msgId/history` 는 `:msgId` 보다 먼저 선언한다 —
   * 'pins' 와 동일한 이유로, 권한 게이트가 붙은 이 고정 서브경로가 동적
   * `:msgId` 단일 세그먼트 매칭에 가려지지 않도록 한다.
   */
  @Get(':msgId/history')
  async history(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
  ): Promise<ListEditHistoryResponse> {
    // 권한 게이트: 작성자 본인 OR OWNER/ADMIN. 삭제된 메시지도 모더레이터는
    // 이력 조회 가능하므로 includeDeleted=true 로 author 판정용 row 를 읽는다.
    const row = await this.messages.requireOne({ channelId, msgId, includeDeleted: true });
    const isAuthor = row.authorId === user.id;
    const isMod = this.isAdminOrOwner(m.role);
    if (!isAuthor && !isMod) {
      throw new DomainError(
        ErrorCode.MESSAGE_NOT_AUTHOR,
        'only the author or a moderator can view edit history',
      );
    }
    // S62 fix-forward (security A-2 = HIGH-1 · FR-RM17): 히스토리 열람도 send 와 동일하게
    // ADMINISTRATOR 채널 우회 감사 대상이다. ADMINISTRATOR 보유자가 채널 DENY overwrite 를
    // 우회해 이력을 열람하면 AuditLog 에 기록한다(관찰성 · best-effort · enforcement 불변).
    // DM(workspaceId 없음)은 내부에서 스킵.
    if (channel) {
      await this.channelAccess.auditAdministratorBypass(
        { id: channel.id, workspaceId: channel.workspaceId },
        user.id,
        'HISTORY_VIEW',
      );
    }
    const items = await this.messages.listEditHistory({ channelId, msgId });
    return { items };
  }

  @Get(':msgId')
  async getOne(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
  ) {
    // Soft-delete visibility rule: non-admin members get 404 on deleted rows
    // (matches the list path's includeDeleted=false default). ADMIN+ can see
    // the row with content masked by `toDto`.
    const row = await this.messages.requireOne({
      channelId,
      msgId,
      includeDeleted: this.isAdminOrOwner(m.role),
    });
    // S17 BLOCKER (read-path bypass): DM(DIRECT) 단건 조회에도 list 와 동일한
    // 가시성 하한선 + 차단 마스킹을 적용한다. 게이트가 없으면 visibleFrom 이전
    // 메시지를 단건으로 열람하거나 차단 author 원문을 단건으로 우회 노출할 수
    // 있다. 비-DIRECT 채널은 무영향(early skip).
    if (channel?.type === 'DIRECT') {
      const visibleFrom = await this.messages.resolveDmVisibleFrom(channelId, user.id);
      // visibleFrom 이전 메시지는 list 에서 안 보이므로 단건도 404 로 통일한다
      // (모더레이터 includeDeleted 경로와 무관 — 가시성은 차단/하한선 정책).
      if (visibleFrom && row.createdAt < visibleFrom) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
      }
      const [rmap, amap, emap, blockedIds] = await Promise.all([
        this.messages.aggregateReactions([row.id], user.id),
        this.messages.aggregateAttachments([row.id]),
        this.messages.aggregateEmbeds([row.id]),
        this.messages.loadBlockedUserIds(user.id),
      ]);
      const [dto] = this.messages.maskBlockedAuthors(
        [
          this.messages.toDto(
            row,
            rmap.get(row.id) ?? [],
            null,
            amap.get(row.id) ?? [],
            null,
            emap.get(row.id) ?? [],
          ),
        ],
        blockedIds,
      );
      return { message: dto };
    }
    const [rmap, amap, emap] = await Promise.all([
      this.messages.aggregateReactions([row.id], user.id),
      this.messages.aggregateAttachments([row.id]),
      this.messages.aggregateEmbeds([row.id]),
    ]);
    return {
      message: this.messages.toDto(
        row,
        rmap.get(row.id) ?? [],
        null,
        amap.get(row.id) ?? [],
        null,
        emap.get(row.id) ?? [],
      ),
    };
  }

  @Post()
  async send(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = SendMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.MESSAGE_CONTENT_INVALID, parsed.error.message);
    }
    // S66 (D13 / FR-W05a): emailVerified=false 사용자는 채널 메시지 전송을 차단한다 →
    // 403 EMAIL_NOT_VERIFIED. JwtStrategy 가 매 요청 DB 에서 emailVerified 를 로드하므로
    // verify-email 직후 다음 전송부터 즉시 통과한다(추가 DB 왕복 없음). DM 을 포함한 모든
    // 전송 경로를 일괄 차단해 미인증 계정이 메시지를 만들지 못하게 한다.
    if (!user.emailVerified) {
      throw new DomainError(
        ErrorCode.EMAIL_NOT_VERIFIED,
        '이메일 인증 후 메시지를 보낼 수 있습니다',
      );
    }
    // S63 (FR-RM07): 모더레이션 타임아웃 lazy 게이트. 워크스페이스 채널에서만 적용
    // (DM 은 m.workspaceId 가 null). mutedUntil>now 면 SEND_MESSAGES 차단 → 403
    // MEMBER_TIMED_OUT. 만료/미설정이면 자동 통과(별도 sweep 불요). USE_SLASH_COMMANDS
    // 도 메시지 전송 경로를 거치므로 슬래시 본문 송신도 함께 막힌다.
    //
    // S63 fix-forward (perf C-1 = SERIOUS-1/2): WorkspaceMemberGuard 가 멤버십 조회에
    // mutedUntil 을 편승시켜 req.workspaceMember(=m)에 싣는다. 종전엔 isTimedOut 이 별도
    // workspaceMember.findUnique 를 발행해 send 가 PK 조회를 3회 했는데, 이제 인라인
    // 비교로 그 DB 왕복을 제거한다(정확성 불변 — lazy 만료를 now 와 직접 비교).
    if (m.workspaceId && m.mutedUntil != null && m.mutedUntil.getTime() > Date.now()) {
      throw new DomainError(
        ErrorCode.MEMBER_TIMED_OUT,
        '타임아웃 중에는 메시지를 보낼 수 없습니다',
      );
    }
    // S71 (FR-W07 / Fork-C): 규칙 동의 서버 게이트. 워크스페이스에 규칙이 존재하는데 멤버가
    // 아직 동의하지 않았으면(rulesAcceptedAt NULL) 403 RULES_NOT_ACCEPTED 로 차단한다.
    // rulesAcceptedAt 은 WorkspaceMemberGuard 가 편승 로드하므로, 미동의(NULL)일 때만 "규칙
    // 존재" 경량 조회를 한다(이미 동의했거나 규칙 0개면 추가 DB 왕복 없음 — hot-path 비용 0).
    // OWNER 는 규칙 작성 주체(생성자)이자 온보딩 비대상이므로 면제한다(Fork A-1 — 기존 멤버
    // 무회귀 · FR-W09a 생성자 특례 일관). 신규 가입 MEMBER/ADMIN 은 동의 전까지 차단된다.
    if (m.workspaceId && m.role !== 'OWNER' && m.rulesAcceptedAt == null) {
      const hasRules = await this.messages.workspaceHasRules(m.workspaceId);
      if (hasRules) {
        throw new DomainError(
          ErrorCode.RULES_NOT_ACCEPTED,
          '규칙에 동의한 후 메시지를 보낼 수 있습니다',
        );
      }
    }
    // S62 fix-forward (perf B-1 = SERIOUS-1/3 / MINOR-1): 워크스페이스 채널이면 멤버
    // 권한 메타(role + 보유 Role UUID/permissions)를 한 번만 로드해 announcement 게이트·
    // ADMINISTRATOR 우회 감사·MENTION_EVERYONE fold 에 재사용한다. 이게 없으면 세 경로가
    // 각각 workspaceMember.findUnique / memberRole.findMany 를 중복 호출했다(hot-path RTT).
    const bypassMember =
      channel && channel.workspaceId !== null
        ? await this.channelAccess.loadAdministratorBypassMember(channel.workspaceId, user.id)
        : null;
    const memberRoleUuids = bypassMember?.memberRoles.map((r) => r.roleId) ?? [];
    // S13 (FR-CH-19): ANNOUNCEMENT 채널은 OWNER/ADMIN/허용역할만 게시 가능.
    // ChannelAccessGuard 가 req.channel(type 포함)을 주입한 뒤 실행된다.
    if (channel) {
      await this.channelAccess.requireAnnouncementPostingAllowed(
        { id: channel.id, type: channel.type, workspaceId: channel.workspaceId },
        user.id,
        m.role,
        memberRoleUuids,
      );
    }
    // S62 (FR-RM17): ADMINISTRATOR 채널 우회 감사. 채널에 DENY overwrite 가 있는데도
    // ADMINISTRATOR 보유자가 게시하면 AuditLog 에 기록한다(관찰성 · best-effort —
    // enforcement 불변). DM(workspaceId 없음)은 내부에서 스킵. 위에서 로드한 멤버
    // 메타를 재사용해 별도 findUnique 를 생략한다(perf B-1).
    if (channel && bypassMember) {
      await this.channelAccess.auditAdministratorBypass(
        { id: channel.id, workspaceId: channel.workspaceId },
        user.id,
        'MESSAGE_SEND',
        bypassMember,
      );
    }
    // S17 (FR-DM-13): 027-era 워크스페이스 스코프 1:1 DM(DIRECT)에도 send 시점
    // BLOCKED 재검증을 적용한다. ChannelAccessGuard 가 이미 로드한 채널 메타
    // (type/name)를 넘겨 send hot-path 의 중복 채널 SELECT 를 없앤다. 비-DIRECT·
    // 그룹 DM 은 메서드 내부에서 스킵.
    if (channel) {
      await this.messages.assertNotBlockedForDmSend(channel.id, user.id, {
        type: channel.type,
        name: channel.name ?? null,
      });
    }
    // S38 (FR-TH-13): 잠긴 스레드 답글 게이트(controller — pin 게이트 패턴 일관,
    // service 오염 회피). 답글(parentMessageId 보유)이고 루트가 threadLocked 면,
    // MEMBER 이하는 403 THREAD_LOCKED 로 막고 OWNER/ADMIN 은 면제한다. 잠금은
    // 루트에만 의미가 있어 isThreadLocked 가 parentMessageId IS NULL 인 루트만
    // true 로 본다(답글-to-답글은 기존 깊이 가드가 별도로 막는다).
    if (parsed.data.parentMessageId && !this.isAdminOrOwner(m.role)) {
      const locked = await this.messages.isThreadLocked(parsed.data.parentMessageId);
      if (locked) {
        throw new DomainError(ErrorCode.THREAD_LOCKED, '스레드가 잠겨 있습니다');
      }
    }
    await this.rate.enforce([
      { key: `msg:send:u:${user.id}`, windowSec: 10, max: this.rateUserMax() },
      { key: `msg:send:c:${channelId}`, windowSec: 10, max: this.rateChannelMax() },
    ]);
    // S15 (FR-CH-08): 채널 슬로우모드 게이트. slowmodeSeconds=0 이면 무동작.
    // BYPASS_SLOWMODE 비트 보유자(OWNER/ADMIN baseline + 채널 override)는 면제.
    // 잔여 쿨다운이 있으면 CHANNEL_SLOWMODE_ACTIVE(429) + retryAfterMs.
    if (channel && channel.slowmodeSeconds > 0) {
      const hasBypass = await this.channelAccess.hasPermission(
        { id: channel.id, workspaceId: channel.workspaceId, isPrivate: channel.isPrivate },
        user.id,
        Permission.BYPASS_SLOWMODE,
      );
      await this.slowmode.enforce({
        channelId: channel.id,
        userId: user.id,
        slowmodeSeconds: channel.slowmodeSeconds,
        hasBypass,
      });
    }
    // S44 (FR-MN-02 / FR-MN-16): `MENTION_EVERYONE`(카탈로그 0x0080) 권한을
    // 채널 override 5단계 fold 로 산정해 send 에 boolean 으로 넘긴다. MEMBER 도
    // override allow 면 true, OWNER/ADMIN 도 override deny 면 false 가 될 수 있다.
    // 워크스페이스 채널 경로에서만 의미가 있어 channel 이 있을 때만 산정한다.
    //
    // S44 fix-forward (MAJOR · perf): 범위 멘션(@everyone/@here/@channel) 신호가
    // 본문 sigil 또는 composer 힌트에 **있을 때만** override fold(findMany 1쿼리)를
    // 수행한다. 신호가 없으면 게이트할 대상이 없어 false 로 skip 해 일반 메시지의
    // +1 RTT 를 제거한다(권한 결과는 어차피 게이트에서 false 멘션에 무영향).
    const wantsBroadMention =
      hasBroadMentionSignal(parsed.data.content) ||
      parsed.data.mentions?.everyone === true ||
      parsed.data.mentions?.here === true ||
      parsed.data.mentions?.channel === true;
    const hasMentionEveryone =
      channel && wantsBroadMention
        ? await this.channelAccess.resolveMentionEveryone(
            { id: channel.id, workspaceId: channel.workspaceId },
            user.id,
            m.role,
            // perf B-1: 위에서 로드한 멤버 Role UUID 재사용(memberRole.findMany 생략).
            memberRoleUuids,
          )
        : false;
    const idempotencyKey = validateIdempotencyKey(idempotencyHeader);
    const { message, replayed } = await this.messages.send({
      workspaceId: m.workspaceId,
      channelId,
      authorId: user.id,
      content: parsed.data.content,
      idempotencyKey,
      // S03 (FR-MSG-04): echo clientNonce on message:created so the sending
      // tab swaps its optimistic row. Distinct ROLE from idempotencyKey.
      nonce: parsed.data.nonce ?? null,
      parentMessageId: parsed.data.parentMessageId ?? null,
      attachmentIds: parsed.data.attachmentIds,
      // S44 (FR-MN-02/16): override-aware MENTION_EVERYONE 권한(불리언) 게이트.
      hasMentionEveryone,
      // S20 (MAJOR/perf): ChannelAccessGuard 가 로드한 channel.type 을 넘겨 send 의
      // DM hidden-restore 게이트가 채널을 다시 SELECT 하지 않게 한다. channel 이
      // undefined 면 send 가 workspaceId 폴백으로 판정한다(여기는 워크스페이스 경로).
      channelType: channel?.type,
      // S21 (FR-RS-16): composer 의 특수멘션 피커 힌트(@everyone/@here/@channel).
      // 본문 sigil 추출값과 OR 병합 후 actorRole 로 게이트된다.
      mentionsHint: parsed.data.mentions,
      // S35 (FR-TH-06): 'Also send to #channel'. parentMessageId 와 함께 true 면
      // 서비스가 SYSTEM_THREAD_BROADCAST 채널 행을 동시 게시한다. 답글이 아닌
      // send 에 true 가 와도 서비스가 parentMessageId 가드로 무시한다.
      isBroadcast: parsed.data.isBroadcast === true,
    });
    if (replayed) res.setHeader('Idempotency-Replayed', 'true');
    res.status(replayed ? 200 : 201);
    // S60 (FR-RC07 · FR-AM-13): 신규 메시지면 본문 URL 의 unfurl 잡을 fire-and-forget 으로
    // enqueue 한다(replay 는 이미 처리됨 — 중복 방지). content/AST 정규화 후 평문 정본으로
    // 추출하면 markdown sigil 이 URL 에 섞이지 않는다 — contentPlain 우선, 없으면 content.
    if (!replayed) {
      this.messages.scheduleUnfurl({
        messageId: message.id,
        channelId,
        workspaceId: m.workspaceId,
        content: message.contentPlainV2 ?? message.contentPlain ?? message.content,
      });
    }
    return { message: this.messages.toDto(message) };
  }

  @UseGuards(MessageAuthorGuard)
  @Patch(':msgId')
  async update(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
    @CurrentMessage() _msg: CurrentMessagePayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.MESSAGE_CONTENT_INVALID, parsed.error.message);
    }
    // S17 MAJOR (edit bypasses send-block gate): 1:1 DM 편집(PATCH)도 send 와
    // 동일하게 BLOCKED 게이트를 건다. 게이트가 없으면 차단 후에도 편집이 가능해
    // message.updated 가 피차단자에게 실시간 push 된다. guard 가 이미 로드한
    // 채널 메타를 넘겨 추가 SELECT 없이 판정. 비-DIRECT·그룹 DM 은 내부 스킵.
    if (channel) {
      await this.messages.assertNotBlockedForDmSend(channel.id, user.id, {
        type: channel.type,
        name: channel.name ?? null,
      });
    }
    // S44 (FR-MN-02/16): edit 시점도 send 와 동일하게 MENTION_EVERYONE override-aware
    // 권한을 산정해 넘긴다. channel 이 있을 때만(워크스페이스 채널) 의미가 있다.
    //
    // S44 fix-forward (MAJOR · perf): 편집 본문에 범위 멘션 sigil 이 있을 때만
    // override fold(findMany 1쿼리)를 수행한다. 신호가 없으면 false 로 skip 해
    // 일반 편집의 +1 RTT 를 제거한다(편집은 composer 힌트가 없어 본문만 스캔).
    const editHasMentionEveryone =
      channel && hasBroadMentionSignal(parsed.data.content)
        ? await this.channelAccess.resolveMentionEveryone(
            { id: channel.id, workspaceId: channel.workspaceId },
            user.id,
            m.role,
          )
        : false;
    const row = await this.messages.update({
      workspaceId: m.workspaceId,
      channelId,
      msgId,
      actorId: user.id,
      content: parsed.data.content,
      // S05 (FR-MSG-06): 낙관적 잠금 기대 version. 불일치 시 service 가
      // MESSAGE_VERSION_CONFLICT(409) + 현재 DTO(details.current)를 throw 하고
      // DomainExceptionFilter 가 표준 envelope 에 details 를 실어 응답한다.
      expectedVersion: parsed.data.expectedVersion,
      // S44 (FR-MN-02/16): override-aware MENTION_EVERYONE 권한 게이트.
      hasMentionEveryone: editHasMentionEveryone,
    });
    // S60 (FR-RC07): 편집으로 본문 URL 이 바뀌었을 수 있으므로 unfurl 을 재enqueue 한다
    // (jobId=messageId 멱등 · MessageEmbed upsert). URL 이 사라졌으면 기존 embed 는 그대로
    // 남지만 read-path 가 본문에 없는 URL 카드를 표시하는 정합은 후속 정리(현 슬라이스는
    // 추가 카드 생성만 — 편집으로 제거된 URL 의 카드 회수는 follow-up).
    this.messages.scheduleUnfurl({
      messageId: row.id,
      channelId,
      workspaceId: m.workspaceId,
      content: row.contentPlainV2 ?? row.contentPlain ?? row.content,
    });
    const [rmap, amap, emap] = await Promise.all([
      this.messages.aggregateReactions([row.id], user.id),
      this.messages.aggregateAttachments([row.id]),
      this.messages.aggregateEmbeds([row.id]),
    ]);
    return {
      message: this.messages.toDto(
        row,
        rmap.get(row.id) ?? [],
        null,
        amap.get(row.id) ?? [],
        null,
        emap.get(row.id) ?? [],
      ),
    };
  }

  /**
   * S64 (D12 / FR-RM09): bulk purge. MANAGE_MESSAGES 권한자가 채널 메시지를 일괄
   * soft-delete 한다(messageIds[] ≤200 또는 latest N ≤200). 단일 updateMany +
   * 단일 BULK_MESSAGE_DELETE AuditLog + 단일 message:bulk_deleted WS 이벤트.
   *
   * 권한: 비작성자 메시지를 지우므로 채널 MANAGE_MESSAGES(=enforcement
   * DELETE_ANY_MESSAGE 0x0008) 비트를 요구한다 — OWNER/ADMIN baseline + 채널 override
   * fold 로 통과한다. 일반 멤버는 403 FORBIDDEN. 200 초과는 zod 가 400 으로 거부한다.
   */
  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
    @Body() body: unknown,
  ): Promise<BulkDeleteResponse> {
    await this.rate.enforce([{ key: `msg:bulkdel:u:${user.id}`, windowSec: 60, max: 20 }]);
    // MANAGE_MESSAGES(=DELETE_ANY_MESSAGE) 비트 게이트(역할 baseline + 채널 override fold).
    const canManage = channel
      ? await this.channelAccess.hasPermission(
          { id: channel.id, workspaceId: channel.workspaceId, isPrivate: channel.isPrivate },
          user.id,
          Permission.DELETE_ANY_MESSAGE,
        )
      : false;
    if (!canManage) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'MANAGE_MESSAGES permission is required to bulk-delete messages',
      );
    }
    const parsed = BulkDeleteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // bulk purge 는 워크스페이스 채널 전용이다(DM 채널은 모더레이션 대상이 아님).
    if (!m.workspaceId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'bulk-delete is not available in direct messages');
    }
    return this.messages.bulkDelete({
      workspaceId: m.workspaceId,
      channelId,
      actorId: user.id,
      messageIds: parsed.data.messageIds,
      latest: parsed.data.latest,
    });
  }

  // DELETE permits author OR ADMIN+. MessageAuthorGuard is intentionally NOT
  // applied here — the service branches on `actorId === authorId || isAdmin`.
  @Delete(':msgId')
  @HttpCode(204)
  async softDelete(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    // S36 fix-forward (보안 MEDIUM): DELETE 레이트리밋. broadcast 행 삭제는 모든
    // 멤버 Redis 채널 unread 캐시를 무효화하므로(반복 삭제 = 무효화 폭주), 사용자
    // 단위로 보수적 윈도를 건다. 평상시 삭제량(수동)엔 여유가 있고 봇 폭주만 막는다.
    await this.rate.enforce([{ key: `msg:del:u:${user.id}`, windowSec: 60, max: 120 }]);
    // Include deleted rows here so "delete already-deleted" is idempotent
    // (returns 204) regardless of caller role.
    const row = await this.messages.requireOne({ channelId, msgId, includeDeleted: true });
    if (row.deletedAt) return; // idempotent
    const isSelf = row.authorId === user.id;
    const isMod = this.isAdminOrOwner(m.role);
    // S51 (FR-PS-15): 핀 추가 시스템 메시지(SYSTEM_PIN)는 채널 멤버 누구나 삭제할 수
    // 있다(Discord 방식) — 작성자(=SYSTEM)도 모더레이터도 아닌 일반 MEMBER 도 허용한다.
    // 가드 체인(WorkspaceMemberGuard + ChannelAccessGuard)이 이미 채널 READ ACL 통과를
    // 강제했으므로 추가 게이트 없이 통과시킨다. 삭제는 이 SYSTEM_PIN 행만 soft-delete
    // 되며, 원본 메시지의 Message.pinnedAt/pinnedBy 는 건드리지 않아 핀 자체는 유지된다
    // (softDelete 는 대상 행의 핀 표식만 null 로 비우는데, SYSTEM_PIN 행은 애초에
    // pinnedAt 이 null 이라 원본 핀에 영향이 없다).
    const isDeletableSystemPin = row.authorType === 'SYSTEM' && row.type === 'SYSTEM_PIN';
    if (!isSelf && !isMod && !isDeletableSystemPin) {
      throw new DomainError(
        ErrorCode.MESSAGE_NOT_AUTHOR,
        'only the author or an ADMIN can delete this message',
      );
    }
    // S64 fix-forward (perf B-1 = SERIOUS-1): 자기 메시지 삭제(isSelf)는 빈번한 hot-path
    // 라 MESSAGE_DELETE 감사를 커밋 후 best-effort 로 기록한다. 모더레이터/강제 삭제
    // (isMod, isDeletableSystemPin 포함)는 감사 원자성을 위해 tx 안에서 동기 기록한다.
    const auditMode = isSelf && !isMod ? 'best-effort' : 'in-tx';
    await this.messages.softDelete({
      workspaceId: m.workspaceId,
      channelId,
      msgId,
      actorId: user.id,
      auditMode,
    });
  }

  /**
   * S60 (FR-AM-16 · FR-RC08): unfurl embed 사후 억제(suppress). 메시지 작성자 또는
   * MANAGE_MESSAGES 권한자(채널 override 포함)가 개별 embed 카드를 끈다. 행 삭제가 아니라
   * suppressedAt 표식이라 동일 URL 재추출 시 깜빡임을 막는다. 성공 시 message:embed_updated
   * 가 채널 룸으로 fanout 되어(서비스가 outbox 발행) 모든 뷰어의 카드가 사라진다.
   *
   * 권한: 작성자(row.authorId===user)는 항상 허용. 비작성자는 채널 MANAGE_MESSAGES 비트
   * (역할 baseline + override fold)를 검사한다 — OWNER/ADMIN 은 baseline 으로 통과하고,
   * override 로 MEMBER 에게 부여됐으면 그도 허용된다. 둘 다 아니면 403 MESSAGE_NOT_AUTHOR.
   */
  @Patch(':msgId/embeds/:embedId/suppress')
  @HttpCode(200)
  async suppressEmbed(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @Param('embedId', new ParseUUIDPipe()) embedId: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
  ) {
    await this.rate.enforce([{ key: `msg:embedsup:u:${user.id}`, windowSec: 60, max: 120 }]);
    // includeDeleted=true 로 author 판정용 row 를 읽는다(삭제 메시지도 모더레이터는 억제 가능).
    const row = await this.messages.requireOne({ channelId, msgId, includeDeleted: true });
    const isAuthor = row.authorId === user.id;
    if (!isAuthor) {
      // 비작성자: MANAGE_MESSAGES(타인 메시지 삭제/핀) 권한 필요. 집행 비트필드(api
      // Permission)에서는 DELETE_ANY_MESSAGE(0x0008)가 shared-types 카탈로그의
      // MANAGE_MESSAGES(0x0008)에 대응한다(역할 baseline + 채널 override fold).
      const canManage = channel
        ? await this.channelAccess.hasPermission(
            { id: channel.id, workspaceId: channel.workspaceId, isPrivate: channel.isPrivate },
            user.id,
            Permission.DELETE_ANY_MESSAGE,
          )
        : false;
      if (!canManage) {
        throw new DomainError(
          ErrorCode.MESSAGE_NOT_AUTHOR,
          'only the author or a message manager can suppress this embed',
        );
      }
    }
    const result = await this.messages.suppressEmbed({
      channelId,
      msgId,
      embedId,
      actorId: user.id,
    });
    return { messageId: msgId, embeds: result.embeds };
  }

  /**
   * S64 (D12 / FR-RM11): 메시지 신고. 채널 READ ACL 을 통과한 모든 멤버가 메시지를
   * 카테고리(SPAM/HARASSMENT/HATE_SPEECH/INAPPROPRIATE/OTHER)로 신고한다. 같은 신고자의
   * 중복 신고는 409 REPORT_DUPLICATE. 신고 큐 열람/처리는 워크스페이스 스코프 컨트롤러.
   *
   * 권한: 가드 체인(WorkspaceMemberGuard + ChannelAccessGuard)이 채널 가시성을 강제하므로
   * 추가 역할 게이트 없이 멤버 누구나 신고할 수 있다. DM 채널(workspaceId=null)은 신고 큐가
   * 워크스페이스 스코프라 거부한다.
   */
  @Post(':msgId/report')
  @HttpCode(204)
  async report(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<void> {
    await this.rate.enforce([{ key: `msg:report:u:${user.id}`, windowSec: 60, max: 30 }]);
    if (!m.workspaceId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'reporting is not available in direct messages');
    }
    const parsed = ReportMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.reports.reportMessage({
      workspaceId: m.workspaceId,
      channelId,
      messageId: msgId,
      reporterId: user.id,
      category: parsed.data.category,
      reason: parsed.data.reason,
    });
  }

  // ----- task-044-iter2: pinned messages -------------------------------

  /**
   * S50 (D10 · FR-PS-03): 채널 핀 카운트 경량 엔드포인트. 채널 헤더 핀 아이콘
   * 배지가 본문/AST 페치 없이 핀 수만 읽도록 한다. 라우트 순서상 `:msgId` 보다
   * 먼저 선언해야 'pins'/'count' 가 UUID 로 오인되지 않는다(listPins 와 동일 이유 —
   * `Get('pins/count')` 는 `Get(':msgId')` 보다 위에 둔다).
   *
   * 권한: 모든 워크스페이스 멤버 + 채널 READ 가시성(가드 체인이 이미 강제). 핀
   * 목록 조회(listPins)와 동일하게 별도 역할 게이트 없음.
   */
  @Get('pins/count')
  async pinCount(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
  ) {
    return this.messages.countPins(channelId);
  }

  /**
   * S50 (D10 · FR-PS-01/05): 메시지 pin. 권한은 **채널 멤버 전체 허용**(PRD
   * "기본값은 채널 멤버 전체 허용") — 가드 체인(WorkspaceMemberGuard +
   * ChannelAccessGuard)이 워크스페이스 멤버십 + 채널 READ 가시성을 이미 강제하므로,
   * READ ACL 을 통과한 멤버는 누구나 핀할 수 있다(읽기전용 게스트는 READ 부재로
   * 가드에서 막힘). OWNER/ADMIN 은 항상 가능(역할 baseline 에 READ 포함).
   *
   * 핀 가능 조건은 service.pin 이 enforce 한다(FR-PS-01): 시스템 메시지 핀 불가
   * (400 VALIDATION_FAILED), soft-deleted 핀 불가(404), hard cap(55) 초과 거부
   * (423 MESSAGE_PIN_CAP_EXCEEDED). 이미 pinned 면 idempotent 200 + 현재 상태
   * (FR-PS-14).
   *
   * S51 (FR-PS-05): 핀 권한 채널 오버라이드. `channel.memberCanPin===false` 인
   * 채널에서는 OWNER/ADMIN 만 핀할 수 있고(역할 baseline), 일반 MEMBER 는 403
   * FORBIDDEN 으로 막힌다. memberCanPin===true(기본)면 종전대로 READ ACL 통과 멤버
   * 전체 허용이다. ★PIN_MESSAGE(0x80) 집행 비트는 여전히 사용하지 않는다 —
   * memberCanPin 컬럼(ChannelAccessGuard 가 req.channel 에 실어 둠)을 직접 검사한다
   * (MENTION_EVERYONE 카탈로그 0x80 과 충돌 회피 — D12). 역할은 req.workspaceMember.role.
   */
  @Post(':msgId/pin')
  @HttpCode(200)
  async pin(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
  ) {
    this.assertCanPin(channel, m.role);
    const row = await this.messages.pin({
      workspaceId: m.workspaceId,
      channelId,
      msgId,
      actorId: user.id,
    });
    return {
      id: row.id,
      pinnedAt: (row.pinnedAt ?? new Date()).toISOString(),
      pinnedBy: row.pinnedBy ?? user.id,
    };
  }

  /**
   * S50 (D10 · FR-PS-01) / S51 (FR-PS-05): 메시지 pin 해제. 권한 게이트는 pin 과
   * 동일하다 — memberCanPin===false 채널에서는 OWNER/ADMIN 만 해제 가능(일반 MEMBER
   * 403). memberCanPin===true(기본)면 READ ACL 통과 멤버 전체 허용. 미고정 상태에서
   * unpin 호출은 게이트 통과 후 idempotent 200.
   */
  @Delete(':msgId/pin')
  @HttpCode(200)
  async unpin(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentChannel() channel: CurrentChannelPayload | undefined,
  ) {
    this.assertCanPin(channel, m.role);
    const row = await this.messages.unpin({
      workspaceId: m.workspaceId,
      channelId,
      msgId,
      actorId: user.id,
    });
    return {
      id: row.id,
      pinnedAt: row.pinnedAt?.toISOString() ?? null,
      pinnedBy: row.pinnedBy ?? null,
    };
  }

  // -----

  private isAdminOrOwner(role: WorkspaceRoleStr): boolean {
    return role === 'ADMIN' || role === 'OWNER';
  }

  /**
   * S51 (FR-PS-05): 핀 권한 게이트. `channel.memberCanPin===false` 인 채널에서는
   * OWNER/ADMIN 만 핀/해제할 수 있고 일반 MEMBER 는 403 FORBIDDEN. memberCanPin===true
   * (기본)이거나 channel 메타가 없으면(가드 체인이 이미 READ ACL 통과를 보장) 통과한다.
   * ★PIN_MESSAGE(0x80) 집행 비트 미사용 — memberCanPin 컬럼만 직접 검사한다(D12).
   */
  private assertCanPin(channel: CurrentChannelPayload | undefined, role: WorkspaceRoleStr): void {
    if (channel && channel.memberCanPin === false && !this.isAdminOrOwner(role)) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        '이 채널에서는 관리자만 메시지를 고정할 수 있습니다',
      );
    }
  }

  private rateUserMax(): number {
    return Number(process.env.MESSAGE_RATE_USER_MAX ?? 30);
  }

  private rateChannelMax(): number {
    return Number(process.env.MESSAGE_RATE_CHANNEL_MAX ?? 60);
  }
}
