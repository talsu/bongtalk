import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ListThreadRepliesQuerySchema,
  SetThreadLockRequestSchema,
  ThreadAckRequestSchema,
  type SetThreadLockResponse,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { MessagesService } from './messages.service';
import { ThreadReadStateService } from './thread-read-state.service';
import { cursorFor, decodeCursor } from './cursor/cursor';

/**
 * Task-014-B: thread replies endpoint. Path is `/messages/:id/thread`
 * at the top level (no workspace / channel prefix) for the same reason
 * as reactions — the message id is globally unique and the workspace +
 * channel are derived inside. Keeps the client's URL construction
 * symmetric between the thread panel and reactions.
 */
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class ThreadsController {
  constructor(
    private readonly messages: MessagesService,
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
    private readonly channelAccess: ChannelAccessByIdGuard,
    // S36 (FR-RS-12 / FR-TH-12/18): 스레드 읽음 커서 코어.
    private readonly threadReadState: ThreadReadStateService,
  ) {}

  /**
   * S36 (FR-RS-12 / FR-TH-12): 루트 메시지 + 채널을 id 로 resolve 하고 READ ACL 을
   * 강제한다. GET(list) / POST(ack) 가 공유하는 단일 출처 — soft-deleted 루트나
   * 채널은 MESSAGE_NOT_FOUND 로 막아 존재 leak 을 차단한다.
   */
  private async resolveThreadRootForAcl(
    id: string,
    userId: string,
  ): Promise<{ channelId: string; channelType: string }> {
    const msg = await this.prisma.message.findFirst({
      where: { id, deletedAt: null },
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
            type: true,
          },
        },
      },
    });
    if (!msg || !msg.channel || msg.channel.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    await this.channelAccess.requireRead(msg.channel, userId);
    // S36 fix-forward (보안 MEDIUM): archived 채널 스레드는 ack/get 을 막는다.
    // ChannelAccessGuard 의 CHANNEL_ARCHIVED 패턴과 동일 — 보관된 채널의 스레드에
    // 읽음 커서를 전진(ack)하거나 답글을 조회(get)할 수 없어야 한다. READ ACL 통과
    // 뒤에 검사해 존재 leak 없이 409 로 수렴한다.
    if (msg.channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived — unarchive first');
    }
    return { channelId: msg.channelId, channelType: msg.channel.type };
  }

  /**
   * S36 (FR-RS-12 / FR-TH-12): POST /messages/:id/thread/ack — 스레드 읽음 ACK.
   *
   * Body `{ lastReadMessageId }`. 루트 채널 READ ACL 통과 후, ThreadReadState 를
   * monotonic (createdAt, id) 튜플 upsert 로 전진시킨다(퇴행 ack no-op). 채널
   * 미읽과 **독립적** — 채널 커서는 건드리지 않는다. 멀티디바이스 동기는 채널
   * 메시지 목록 refetch 시 threadMeta.hasUnread 가 재수렴시킨다(별도 read-state
   * WS 이벤트는 본 슬라이스 범위 밖 — Threads 탭 S38 에서 도입 검토). 204.
   */
  @Post(':id/thread/ack')
  @HttpCode(204)
  async ack(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<void> {
    // 채널 미읽 ack 와 동일한 보수적 레이트 — 스크롤 디바운스가 새도 안전.
    await this.rate.enforce([{ key: `thread:ack:u:${user.id}`, windowSec: 60, max: 600 }]);
    const parsed = ThreadAckRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // 루트 채널 READ ACL — 임의 root UUID 로 타 채널 스레드를 ack 하는 IDOR 차단.
    await this.resolveThreadRootForAcl(id, user.id);
    await this.threadReadState.ackThread({
      userId: user.id,
      parentMessageId: id,
      lastReadMessageId: parsed.data.lastReadMessageId,
    });
  }

  /**
   * S38 (FR-TH-13): PATCH /messages/:id/thread/lock — 스레드 잠금/해제.
   *
   * Body `{ locked }`. **OWNER/ADMIN 만**(controller 역할 게이트 — pin 권한 패턴과
   * 일관). 루트 메시지의 channel → workspace 를 resolve 한 뒤, 요청자가 그
   * 워크스페이스 OWNER/ADMIN 이 아니면 403 WORKSPACE_INSUFFICIENT_ROLE. 통과 시
   * Message.threadLocked 를 토글하고 thread:lock:changed 를 채널 룸으로 emit 한다.
   * DM(DIRECT·workspaceId NULL) 채널은 워크스페이스 역할 개념이 없어 잠금을
   * 지원하지 않는다(403 — 워크스페이스 채널 전용 기능).
   */
  @Patch(':id/thread/lock')
  @HttpCode(200)
  async lock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<SetThreadLockResponse> {
    await this.rate.enforce([{ key: `thread:lock:u:${user.id}`, windowSec: 60, max: 120 }]);
    const parsed = SetThreadLockRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // 루트 채널 READ ACL + archived 차단(ack/get 과 동일 출처).
    const { channelId } = await this.resolveThreadRootForAcl(id, user.id);
    // 채널의 workspaceId 를 확보하고 요청자 역할(OWNER/ADMIN)을 검증한다.
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, workspaceId: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if (!channel.workspaceId) {
      // DM/그룹 DM: 워크스페이스 역할 게이트가 없어 잠금 미지원.
      throw new DomainError(ErrorCode.WORKSPACE_INSUFFICIENT_ROLE, 'DM 스레드는 잠글 수 없습니다');
    }
    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: channel.workspaceId, userId: user.id },
      },
      select: { role: true },
    });
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'OWNER 또는 ADMIN 만 스레드를 잠그거나 해제할 수 있습니다',
      );
    }
    const result = await this.messages.setThreadLock({
      workspaceId: channel.workspaceId,
      channelId,
      rootId: id,
      actorId: user.id,
      locked: parsed.data.locked,
    });
    return result;
  }

  @Get(':id/thread')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    // Same generous GET budget as the main messages list. Thread panel
    // scroll-to-top triggers refetch; cap keeps misbehaving clients from
    // hot-looping.
    await this.rate.enforce([{ key: `thread:get:u:${user.id}`, windowSec: 60, max: 600 }]);
    const parsed = ListThreadRepliesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }

    // Resolve channel via the message id so the controller can run the
    // same ACL check path reactions use. The message must still exist;
    // soft-deleted roots surface `MESSAGE_NOT_FOUND` so the UI closes
    // the panel.
    const msg = await this.prisma.message.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        channelId: true,
        parentMessageId: true,
        channel: {
          select: {
            id: true,
            workspaceId: true,
            isPrivate: true,
            archivedAt: true,
            deletedAt: true,
            // S17 BLOCKER (read-path bypass): DIRECT 여부 판정용. 스레드 응답에도
            // DM 차단 마스킹을 걸기 위해 채널 type 을 함께 로드한다(추가 round-trip
            // 없음 — 동일 channel relation select).
            type: true,
          },
        },
      },
    });
    if (!msg || !msg.channel || msg.channel.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    await this.channelAccess.requireRead(msg.channel, user.id);
    // S36 fix-forward (보안 MEDIUM): archived 채널 스레드 GET 차단(ack 경로와 동일
    // CHANNEL_ARCHIVED). 보관 채널의 스레드 패널을 열 수 없게 한다.
    if (msg.channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived — unarchive first');
    }

    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    const page = await this.messages.listThreadReplies({
      channelId: msg.channelId,
      rootId: id,
      cursor,
      limit: parsed.data.limit,
    });

    const ids = [page.root.id, ...page.items.map((r) => r.id)];
    // Reactions + attachments on both the root + replies for a single-query join.
    // S17 BLOCKER (read-path bypass): DIRECT 채널(1:1/그룹 DM) 스레드면 차단
    // 사용자 집합을 함께 로드해 루트·답변 DTO 모두에 마스킹을 건다. 비-DIRECT
    // 채널은 빈 집합이라 maskBlockedAuthors 가 무동작(early return, 회귀 없음).
    const isDirect = msg.channel.type === 'DIRECT';
    const [reactions, rootSummaries, attachments, blockedIds, readCursor, viewerSub] =
      await Promise.all([
        this.messages.aggregateReactions(ids, user.id),
        // S36 (FR-TH-04): 루트 thread chip 의 hasUnread 도 viewer 기준으로 산정.
        this.messages.aggregateThreadSummaries([page.root.id], user.id),
        this.messages.aggregateAttachments(ids),
        isDirect ? this.messages.loadBlockedUserIds(user.id) : Promise.resolve(new Set<string>()),
        // S36 (FR-TH-18): 초기 스크롤 앵커용 lastRead 커서. 행이 없으면 null
        // (전체 미읽 → 프론트가 최하단 스크롤). 패널 GET 1회에 함께 실어 보낸다.
        this.threadReadState.cursorFor(user.id, id),
        // S38 fix-forward (reviewer MAJOR / FR-TH-08): viewer 의 스레드 알림 레벨.
        // ThreadPanel 의 벨이 저장된 OFF/MENTIONS 를 반영하려면 GET 응답에 현재
        // 레벨이 실려야 한다(종전엔 항상 'ALL' seed). 같은 GET 1회에 구독 행을
        // 조회해 함께 내려보낸다(별도 라운드트립 0 — Promise.all 병합). 구독 행이
        // 없으면 null(프론트는 'ALL' 로 표시하되 서버 구독을 만들지 않는다).
        this.prisma.threadSubscription.findUnique({
          where: { userId_threadParentId: { userId: user.id, threadParentId: id } },
          select: { notificationLevel: true },
        }),
      ]);
    const rootSummary = rootSummaries.get(page.root.id);

    const [rootDto] = this.messages.maskBlockedAuthors(
      [
        this.messages.toDto(
          page.root,
          reactions.get(page.root.id) ?? [],
          rootSummary ?? null,
          attachments.get(page.root.id) ?? [],
        ),
      ],
      blockedIds,
    );
    const replyDtos = this.messages.maskBlockedAuthors(
      page.items.map((r) =>
        this.messages.toDto(
          r,
          reactions.get(r.id) ?? [],
          null /* replies are leaves */,
          attachments.get(r.id) ?? [],
        ),
      ),
      blockedIds,
    );

    return {
      root: rootDto,
      replies: replyDtos,
      // S36 (FR-TH-18): viewer 의 스레드 읽음 커서. 프론트는 lastReadMessageId 가
      // 있으면 그 다음 첫 미읽 답글 위치로 초기 스크롤하고, null 이면 최하단으로
      // 스크롤한다(기존 S35 동작). 첫 페이지에만 의미가 있어 매 페이지 반환하되
      // 프론트는 첫 페이지 값만 쓴다.
      readState: { lastReadMessageId: readCursor?.lastReadMessageId ?? null },
      // S38 fix-forward (FR-TH-08): viewer 의 스레드 알림 레벨(벨 seed). 미구독 null.
      viewerNotificationLevel: viewerSub?.notificationLevel ?? null,
      pageInfo: {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
          ? cursorFor({ id: page.nextCursor.id, createdAt: page.nextCursor.createdAt })
          : null,
        prevCursor: page.prevCursor
          ? cursorFor({ id: page.prevCursor.id, createdAt: page.prevCursor.createdAt })
          : null,
      },
    };
  }
}
