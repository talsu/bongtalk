import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Server } from 'socket.io';
import { WS_EVENTS } from '@qufox/shared-types';
import { RealtimeGateway } from '../realtime.gateway';
import { rooms } from '../rooms/room-names';
import { ReplayBufferService } from './replay-buffer.service';
import { ChannelSeqService } from './channel-seq.service';
import type { WsEnvelope } from '../events/ws-event-envelope';
import { MetricsService } from '../../observability/metrics/metrics.service';
import { withSpan } from '../../observability/otel/propagation';
import { MessagesService } from '../../messages/messages.service';
import { MeNotificationBadgesService } from '../../me/me-notification-badges.service';
import { PrismaService } from '../../prisma/prisma.module';

function pickTargetUserId(env: WsEnvelope): string | null {
  const memberField = (env as { member?: { userId?: string } }).member;
  if (memberField?.userId) return memberField.userId;
  // Workspace member events carry `userId` at the top level.
  const userIdField = (env as { userId?: string }).userId;
  if (userIdField) return userIdField;
  const targetField = (env as { targetUserId?: string }).targetUserId;
  return targetField ?? null;
}

/**
 * Bridges the OutboxDispatcher's EventEmitter2 output onto Socket.IO rooms.
 * The dispatcher calls `emitAsync(eventType, envelope)` inside the same
 * event loop turn as the DB mark-dispatched write, so our @OnEvent handler
 * receives the envelope exactly once per outbox tick. We then:
 *
 *   1. append to the per-channel replay buffer (or per-workspace for ws-level
 *      events) for reconnect catch-up
 *   2. io.to(room).emit(eventType, envelope) — adapter fans across nodes
 *
 * Delivery semantics inherit from outbox: at-least-once. Clients dedupe by
 * envelope.id.
 */
@Injectable()
export class OutboxToWsSubscriber {
  private readonly logger = new Logger(OutboxToWsSubscriber.name);

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly replay: ReplayBufferService,
    private readonly seq: ChannelSeqService,
    // S39 (FR-RE03): message.reaction.updated 수신 시 집계 재조회용.
    private readonly messages: MessagesService,
    // S47 (FR-MN-20): 멘션 발생 시 서버 진실값 배지(isMuted 제외) 재집계용.
    private readonly badges: MeNotificationBadgesService,
    // S70 fix-forward (security M-3): application.received 를 ADMIN+ user 룸으로만
    // 보내기 위한 ADMIN+ userId 저빈도 조회용.
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  private get io(): Server | null {
    return this.gateway.server ?? null;
  }

  @OnEvent('message.**')
  async onMessageEvent(env: WsEnvelope): Promise<void> {
    const chId = env.channelId ?? (env as { message?: { channelId?: string } }).message?.channelId;
    if (!chId) return;
    // S38 (FR-TH-13): thread lock 변경은 PRD 가 wire 이름 `thread:lock:changed` 를
    // 명시한다. 서버 내부 outbox eventType 은 dot 표기(message.thread.lock_changed)
    // 라 `message.**` 와일드카드가 잡지만, 채널 룸 emit 시 콜론 wire 이름으로
    // 바꿔 보낸다(클라 dispatcher 가 'thread:lock:changed' 로 수신). replay 버퍼에는
    // wire 이름으로 적재해 재연결 catch-up 도 동일 이름으로 도착한다.
    if (env.type === 'message.thread.lock_changed') {
      const wireEnv = { ...env, type: 'thread:lock:changed' as const };
      await this.emitAndBuffer('channel', chId, wireEnv as WsEnvelope);
      return;
    }
    // S39 (FR-RE03): message.reaction.updated → 콜론 wire `reaction:updated`.
    // 서버 내부 outbox eventType 은 dot 표기라 `message.**` 와일드카드가 잡지만,
    // 채널 룸 emit 시 PRD 가 명시한 콜론 wire 이름으로 변환한다. 옵션 B 집계:
    // payload 에는 식별자만 실려오므로, 여기서 aggregateReactionDetails 로 전체
    // 집계(emoji/count/users[≤5])를 재조회해 enriched wire payload 를 만든다.
    // per-viewer `me` 는 브로드캐스트라 담지 않으며, 클라 dispatcher 가 users 에
    // 자신의 userId 포함 여부로 로컬 계산한다(카운트/리스트는 WS 가 진실값).
    if (env.type === 'message.reaction.updated') {
      const messageId = (env as { messageId?: string }).messageId;
      if (!messageId) return;
      const reactions = await this.messages.aggregateReactionDetails(messageId);
      const wireEnv = {
        id: env.id,
        type: WS_EVENTS.REACTION_UPDATED,
        occurredAt: env.occurredAt,
        channelId: chId,
        messageId,
        reactions,
      } as unknown as WsEnvelope;
      await this.emitAndBuffer('channel', chId, wireEnv);
      return;
    }
    // S40 (FR-RE09): message.reaction.cleared → 콜론 wire `reaction:cleared`.
    // OWNER/ADMIN 의 메시지 전체 반응 일괄 삭제다. 전체 제거라 집계가 없어
    // 식별자(messageId + channelId)만 실어 채널 룸으로 fanout 한다. 수신 클라
    // dispatcher 는 해당 messageId 의 reactions 를 통째로 비운다(full clear).
    if (env.type === 'message.reaction.cleared') {
      const messageId = (env as { messageId?: string }).messageId;
      if (!messageId) return;
      const wireEnv = {
        id: env.id,
        type: WS_EVENTS.REACTION_CLEARED,
        occurredAt: env.occurredAt,
        channelId: chId,
        messageId,
      } as unknown as WsEnvelope;
      await this.emitAndBuffer('channel', chId, wireEnv);
      return;
    }
    // S50 (D10 · FR-PS-02/06): message.pin.toggled → pinnedAt 의 null 여부로
    // channel:pin_added / channel:pin_removed 콜론 wire 로 분기·변환한다(서버 내부
    // outbox eventType 은 dot 표기라 `message.**` 와일드카드가 잡는다). pin_added 는
    // 핀 메타 + 자동 삽입된 SYSTEM_PIN 시스템 메시지 id + 갱신 후 핀 수(used)를,
    // pin_removed 는 해제된 messageId + 해제 주체·시각을 싣는다(reaction:updated /
    // thread:lock:changed 선례). 핀 추가로 삽입된 SYSTEM_PIN 시스템 메시지 자체는
    // 별도 message.created 이벤트로 채널 룸에 도착하므로 여기서 또 emit 하지 않는다.
    if (env.type === 'message.pin.toggled') {
      const messageId = (env as { messageId?: string }).messageId;
      if (!messageId) return;
      const pinnedAt = (env as { pinnedAt?: string | null }).pinnedAt ?? null;
      const actorId = (env as { actorId?: string }).actorId ?? null;
      if (pinnedAt) {
        const wireEnv = {
          id: env.id,
          type: WS_EVENTS.CHANNEL_PIN_ADDED,
          occurredAt: env.occurredAt,
          channelId: chId,
          messageId,
          pinnedAt,
          pinnedBy: (env as { pinnedBy?: string | null }).pinnedBy ?? actorId,
          systemMessageId: (env as { systemMessageId?: string | null }).systemMessageId ?? null,
          used: (env as { used?: number }).used,
        } as unknown as WsEnvelope;
        await this.emitAndBuffer('channel', chId, wireEnv);
      } else {
        const wireEnv = {
          id: env.id,
          type: WS_EVENTS.CHANNEL_PIN_REMOVED,
          occurredAt: env.occurredAt,
          channelId: chId,
          messageId,
          unpinnedById: actorId,
          unpinnedAt: env.occurredAt,
        } as unknown as WsEnvelope;
        await this.emitAndBuffer('channel', chId, wireEnv);
      }
      return;
    }
    // S60 (FR-RC07/08): message.embed.updated → 콜론 wire `message:embed_updated`. 서버
    // 내부 outbox eventType 은 dot 표기라 `message.**` 와일드카드가 잡는다. UnfurlProcessor
    // 또는 suppress 경로가 발행하며, payload 에 해당 메시지의 비-suppress embed 전체
    // 스냅샷(embeds[])이 실려온다(idempotent replace). 채널 룸으로 fanout 하면 모든 뷰어가
    // messages.list 캐시의 해당 messageId 행 embeds 를 통째로 교체한다.
    if (env.type === 'message.embed.updated') {
      const messageId = (env as { messageId?: string }).messageId;
      if (!messageId) return;
      const wireEnv = {
        id: env.id,
        type: WS_EVENTS.MESSAGE_EMBED_UPDATED,
        occurredAt: env.occurredAt,
        channelId: chId,
        messageId,
        embeds: (env as { embeds?: unknown }).embeds ?? [],
      } as unknown as WsEnvelope;
      await this.emitAndBuffer('channel', chId, wireEnv);
      return;
    }
    // S64 (FR-RM09): message.bulk_deleted → 콜론 wire `message:bulk_deleted`. 서버
    // 내부 outbox eventType 은 dot 표기라 `message.**` 와일드카드가 잡는다. bulk purge 가
    // 발행하며, payload 에 실제 soft-delete 된 messageIds[] 가 실려온다. 채널 룸으로
    // fanout 하면 수신 클라가 해당 messageIds 를 타임라인 캐시에서 한 번에 제거한다.
    if (env.type === 'message.bulk_deleted') {
      const messageIds = (env as { messageIds?: string[] }).messageIds ?? [];
      const wireEnv = {
        id: env.id,
        type: WS_EVENTS.MESSAGE_BULK_DELETED,
        occurredAt: env.occurredAt,
        channelId: chId,
        actorId: (env as { actorId?: string }).actorId ?? null,
        messageIds,
      } as unknown as WsEnvelope;
      await this.emitAndBuffer('channel', chId, wireEnv);
      return;
    }
    await this.emitAndBuffer('channel', chId, env);

    // Task-014-B thread.replied: channel-room fanout above keeps
    // everyone-in-channel's count/avatar stack in sync. For reply
    // notifications (toast + inbox bump) we additionally emit to each
    // recipient's private room so offline users catch up on reconnect
    // via user-scoped replay. Dedupe vs mention.received happens on
    // the client side (same-message preference).
    if (env.type === 'message.thread.replied' && this.io) {
      const recipients = (env as { recipients?: string[] }).recipients ?? [];
      for (const uid of recipients) {
        try {
          await this.replay.append('user', uid, {
            id: env.id,
            type: env.type,
            occurredAt: env.occurredAt,
            payload: env,
          });
        } catch (err) {
          this.logger.warn(
            `[realtime] reply replay append failed uid=${uid} ev=${env.id} err=${String(err).slice(0, 200)}`,
          );
        }
        this.io.to(rooms.user(uid)).emit(env.type, env);
      }
    }
  }

  /**
   * Task-011-B mention.received. Routes to the target user's private
   * room (same pattern as membership-revocation events). The outbox
   * emits one such event per mentioned user at write time, so this
   * handler receives a single envelope per (message, user) pair.
   * Replay scope is 'user' — a reconnecting user can catch up on
   * mentions that landed while they were offline.
   */
  @OnEvent('mention.**')
  async onMentionEvent(env: WsEnvelope): Promise<void> {
    const targetUserId = pickTargetUserId(env);
    if (!targetUserId || !this.io) return;
    // S44 (FR-MN-01): 서버 내부 outbox eventType 은 dot 표기(mention.received)지만
    // PRD WS 카탈로그가 명시한 콜론 wire 이름 `mention:new` 로 변환해 emit/buffer
    // 한다(reaction:updated / thread:lock:changed / emoji:* 선례). 페이로드는
    // 그대로(MentionNewPayload 와 정합) 두되 type 만 wire 이름으로 바꾼다. replay
    // 버퍼에도 wire 이름으로 적재해 재연결 catch-up 이 동일 이름으로 도착하게 한다.
    const wireEnv = { ...env, type: WS_EVENTS.MENTION_NEW } as WsEnvelope;
    try {
      await this.replay.append('user', targetUserId, {
        id: wireEnv.id,
        type: wireEnv.type,
        occurredAt: wireEnv.occurredAt,
        payload: wireEnv,
      });
    } catch (err) {
      this.logger.warn(
        `[realtime] replay append failed scope=user id=${targetUserId} ev=${wireEnv.id} err=${String(err).slice(0, 200)}`,
      );
    }
    await withSpan(
      'ws.emit',
      { 'ws.event.type': wireEnv.type, 'ws.room': rooms.user(targetUserId) },
      async () => {
        this.io!.to(rooms.user(targetUserId)).emit(wireEnv.type, wireEnv);
      },
    );
    // task-016-B (009-nit-4): bucket env.type through the allowlist.
    this.metrics?.wsEventsEmittedTotal
      .labels(this.metrics.bucket('wsEventType', wireEnv.type))
      .inc();

    // S47 (FR-MN-20): 멘션이 도착한 워크스페이스의 서버 진실값 배지를 재집계해
    // notification:badge_update 를 같은 user 룸으로 emit 한다. 서버값이라 클라가
    // 낙관적 +1 을 이 값으로 교체한다(last-write-wins). isMuted 채널/서버는 배지
    // 집계에서 제외된다(MeNotificationBadgesService 게이트 — 카운트 증가 자체 skip).
    // 멘션 fanout 은 이미 mute/DND/NotifLevel 게이트를 통과한 수신자에게만 도달하지만,
    // 배지는 *서버 단위 진실값* 이므로 여기서 다시 mute-제외 집계를 거친다(채널 뮤트가
    // mention:new 를 막지 않는 @here/everyone 경계에서도 배지는 정확히 0 유지).
    const workspaceId = (env as { workspaceId?: string | null }).workspaceId ?? null;
    if (workspaceId) {
      // S69 (FR-W23): 활성 워크스페이스 무관, 멘션이 도착한 워크스페이스의 user 룸으로
      // unread_count:increment(+1)를 **workspaceId 포함** emit 한다. 클라는 이 페이로드의
      // workspaceId 로 비활성 워크스페이스라도 서버아이콘 멘션 배지를 즉시(낙관) +1 한다.
      // 직후 emitBadgeUpdate 의 서버 진실값(notification:badge_update)이 last-write-wins
      // 으로 이 낙관값을 교정한다. user 룸은 이미 보유(추가 DB 쿼리 없음).
      const incPayload = {
        channelId: env.channelId ?? null,
        delta: 1,
        workspaceId,
      };
      this.io.to(rooms.user(targetUserId)).emit(WS_EVENTS.UNREAD_COUNT_INCREMENT, incPayload);
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.UNREAD_COUNT_INCREMENT))
        .inc();
      await this.emitBadgeUpdate(targetUserId, workspaceId, env.channelId ?? null);
    }
  }

  /**
   * S47 (FR-MN-20): user 룸으로 서버 진실값 배지(isMuted 제외)를 emit 한다.
   * 집계 실패는 비-치명(클라가 reconnect/visibility resync 로 자가 치유) — 멘션
   * 전달 자체는 이미 끝났으므로 throw 하지 않고 로깅만 한다.
   */
  private async emitBadgeUpdate(
    userId: string,
    workspaceId: string,
    channelId: string | null,
  ): Promise<void> {
    if (!this.io) return;
    try {
      const badge = await this.badges.badgeFor(userId, workspaceId);
      const payload = {
        serverId: workspaceId,
        channelId,
        mentionCount: badge.mentionCount,
        unreadCount: badge.unreadCount,
        serverTimestamp: new Date().toISOString(),
      };
      await withSpan(
        'ws.emit',
        {
          'ws.event.type': WS_EVENTS.NOTIFICATION_BADGE_UPDATE,
          'ws.room': rooms.user(userId),
        },
        async () => {
          this.io!.to(rooms.user(userId)).emit(WS_EVENTS.NOTIFICATION_BADGE_UPDATE, payload);
        },
      );
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.NOTIFICATION_BADGE_UPDATE))
        .inc();
    } catch (err) {
      this.logger.warn(
        `[realtime] badge_update emit failed uid=${userId} ws=${workspaceId} err=${String(err).slice(0, 200)}`,
      );
    }
  }

  @OnEvent('channel.**')
  async onChannelEvent(env: WsEnvelope): Promise<void> {
    // channel.created is new to the receiver — they might not be in the
    // channel room yet — so route via the workspace room instead.
    const wsId = env.workspaceId;
    if (!wsId) return;
    if (env.type === 'channel.created' || env.type === 'channel.deleted') {
      await this.emitAndBuffer('workspace', wsId, env);
      // task-019-B (018-follow-3): refresh SocketState.channelIds for
      // every currently-connected workspace member so they can
      // typing.ping / channel:read on the new channel without a
      // reconnect.
      await this.refreshChannelIdsForWorkspace(wsId);
      return;
    }
    const chId = env.channelId ?? (env as { channel?: { id?: string } }).channel?.id;
    if (chId) {
      await this.emitAndBuffer('channel', chId, env);
    }
    // Sidebar reorder / archive toggle also needs the workspace view.
    await this.emitAndBuffer('workspace', wsId, env);
  }

  @OnEvent('category.**')
  async onCategoryEvent(env: WsEnvelope): Promise<void> {
    if (!env.workspaceId) return;
    await this.emitAndBuffer('workspace', env.workspaceId, env);
  }

  /**
   * S70 (D13 / FR-W06·W06a): 가입 신청 라이프사이클.
   *   - application.received → 워크스페이스 ADMIN+(OWNER/ADMIN — 신청 목록 권한과 동일) 의
   *     user 룸(user:{adminId})으로만 ws:application_received 를 emit 한다. 종전엔
   *     workspace:{wsId} 전체 룸으로 fanout 해 일반 멤버에게도 applicantId/applicantName 이
   *     노출됐다(security M-3). ADMIN+ userId 를 저빈도 조회(신청 제출은 드묾)해 각 user 룸으로만
   *     보낸다. ADMIN 리뷰 패널이 목록을 즉시 갱신한다.
   *   - application.reviewed → 신청자 본인 user 룸(user:{applicantId})으로 ws:application_reviewed
   *     fanout. 신청자는 대기 화면에서 approved(토스트+2초 이동)/rejected(거절 카피+reviewNote)/
   *     interview(인터뷰 안내)로 분기한다. 본인 user 룸이라 워크스페이스 멤버가 아닌 신청자
   *     에게도 도달한다(승인 전 서버 룸 미가입 — mention.** / dm.** 의 user-room fanout 선례).
   * 서버 내부 outbox eventType 은 dot 표기지만 여기서 PRD 가 명시한 콜론 wire 이름으로 변환한다.
   */
  @OnEvent('application.**')
  async onApplicationEvent(env: WsEnvelope): Promise<void> {
    if (!this.io) return;
    const workspaceId = (env as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return;
    const applicationId = (env as { applicationId?: string }).applicationId;
    if (!applicationId) return;

    if (env.type === 'application.received') {
      // M-3: ADMIN+(OWNER/ADMIN) user 룸으로만 emit — 일반 멤버에게 신청자 식별정보 노출 차단.
      const admins = await this.prisma.workspaceMember.findMany({
        where: { workspaceId, role: { in: ['OWNER', 'ADMIN'] } },
        select: { userId: true },
      });
      if (admins.length === 0) return;
      const wire = {
        id: env.id,
        type: WS_EVENTS.APPLICATION_RECEIVED,
        occurredAt: env.occurredAt,
        workspaceId,
        applicationId,
        applicantId: (env as { applicantId?: string }).applicantId ?? '',
        applicantName: (env as { applicantName?: string }).applicantName ?? '',
      };
      for (const a of admins) {
        this.io.to(rooms.user(a.userId)).emit(WS_EVENTS.APPLICATION_RECEIVED, wire);
      }
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.APPLICATION_RECEIVED))
        .inc();
      return;
    }

    if (env.type === 'application.reviewed') {
      const applicantId = (env as { applicantId?: string }).applicantId;
      const status = (env as { status?: string }).status;
      if (
        !applicantId ||
        (status !== 'approved' && status !== 'rejected' && status !== 'interview')
      )
        return;
      const wire = {
        id: env.id,
        type: WS_EVENTS.APPLICATION_REVIEWED,
        occurredAt: env.occurredAt,
        workspaceId,
        applicationId,
        status,
        reviewNote: (env as { reviewNote?: string | null }).reviewNote ?? null,
        interviewChannelId:
          (env as { interviewChannelId?: string | null }).interviewChannelId ?? null,
      };
      try {
        await this.replay.append('user', applicantId, {
          id: env.id,
          type: wire.type,
          occurredAt: env.occurredAt,
          payload: wire,
        });
      } catch (err) {
        this.logger.warn(
          `[realtime] application reviewed replay append failed uid=${applicantId} ev=${env.id} err=${String(err).slice(0, 200)}`,
        );
      }
      this.io.to(rooms.user(applicantId)).emit(WS_EVENTS.APPLICATION_REVIEWED, wire);
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.APPLICATION_REVIEWED))
        .inc();
    }
  }

  /**
   * S41 (FR-EM01 / FR-EM04 / FR-RC20): 워크스페이스 커스텀 이모지 라이프사이클.
   * 서버 내부 outbox eventType 은 dot 표기(emoji.created / emoji.deleted)지만,
   * 워크스페이스 룸 emit 시 PRD/WS_EVENTS 가 명시한 콜론 wire 이름
   * (emoji:created / emoji:deleted)으로 변환한다(reaction:updated /
   * thread:lock:changed 선례). payload 의 workspaceId 로 workspace:{wsId} 룸에
   * fanout 한다 — 커스텀 이모지는 채널이 아니라 워크스페이스 스코프라 채널 룸이
   * 아니라 워크스페이스 룸이 정확하다. replay 버퍼에도 wire 이름으로 적재해
   * 재연결 catch-up 이 동일 이름으로 도착하게 한다(emitAndBuffer 의 workspace 스코프).
   */
  @OnEvent('emoji.**')
  async onEmojiEvent(env: WsEnvelope): Promise<void> {
    const wsId = (env as { workspaceId?: string }).workspaceId;
    if (!wsId) return;
    const emojiId = (env as { emojiId?: string }).emojiId;
    if (!emojiId) return;
    // S42 (FR-EM05): emoji.alias_updated → 콜론 wire `emoji:alias_updated`. created/
    // deleted 와 달리 name 이 아니라 aliases 스냅샷을 싣는다. created/deleted 는 name
    // 필수, alias_updated 는 aliases 배열 필수.
    if (env.type === 'emoji.alias_updated') {
      const aliases = (env as { aliases?: unknown }).aliases;
      if (!Array.isArray(aliases)) return;
      const wireEnv = {
        id: env.id,
        type: WS_EVENTS.EMOJI_ALIAS_UPDATED,
        occurredAt: env.occurredAt,
        workspaceId: wsId,
        emojiId,
        aliases: aliases.filter((a): a is string => typeof a === 'string'),
      } as unknown as WsEnvelope;
      await this.emitAndBuffer('workspace', wsId, wireEnv);
      return;
    }
    const name = (env as { name?: string }).name;
    if (!name) return;
    const wireType =
      env.type === 'emoji.created'
        ? WS_EVENTS.EMOJI_CREATED
        : env.type === 'emoji.deleted'
          ? WS_EVENTS.EMOJI_DELETED
          : null;
    if (!wireType) return;
    const wireEnv = {
      id: env.id,
      type: wireType,
      occurredAt: env.occurredAt,
      workspaceId: wsId,
      emojiId,
      name,
    } as unknown as WsEnvelope;
    await this.emitAndBuffer('workspace', wsId, wireEnv);
  }

  /**
   * S16 (FR-DM-16) dm.created. 새 DM·그룹 DM 개설 시 멤버 전원의 private
   * room(user:{userId})으로 와이어 이벤트 `dm:created` 를 fanout 한다.
   * 수신자는 아직 채널 룸에 없을 수 있으므로(목록을 막 받는 중) channel 룸이
   * 아니라 user 룸으로 보낸다. mention.** 와 동일한 recipient 패턴이다.
   *
   * S16 (HIGH fix-forward): `recipients` 는 **라우팅 전용**(어느 user 룸으로
   * 보낼지)이므로 와이어 페이로드에서 제거한다 — 그대로 emit 하면 참여자 UUID
   * 전체가 모든 수신자에게 노출된다. emit shape 은 { id, type, occurredAt,
   * channelId, isGroup, participantIds }.
   *
   * replay 스코프는 'user' 로 버퍼에 기록은 하지만, 현재 gateway 는 user-scope
   * 버퍼를 드레인하지 않는다(channel-scope replay 만 재전송). 따라서 클라이언트는
   * 재연결 시 이 버퍼가 아니라 REST(/me/dms·/me/dms/groups) 재조회로 새 DM 을
   * 갱신한다. user-scope 버퍼는 향후 gateway 드레인 도입 시를 위한 선행 기록이다.
   */
  @OnEvent('dm.**')
  async onDmEvent(env: WsEnvelope): Promise<void> {
    if (!this.io) return;
    // recipients 는 서버에서만 쓰는 라우팅 정보 — 와이어로 내보내지 않는다(H-03).
    const recipients = (env as { recipients?: string[] }).recipients ?? [];
    if (recipients.length === 0) return;

    // S19: 내부 dot 이벤트명 → 콜론 와이어명 + recipients 제거한 최소 페이로드.
    // 참여자 UUID 전체 노출 금지 — 각 이벤트가 변경 대상 최소 필드만 싣는다.
    const built = this.buildDmWire(env);
    if (!built) return;
    const { wireType, wire } = built;

    for (const uid of recipients) {
      try {
        await this.replay.append('user', uid, {
          id: env.id,
          type: wireType,
          occurredAt: env.occurredAt,
          payload: wire,
        });
      } catch (err) {
        this.logger.warn(
          `[realtime] dm replay append failed uid=${uid} ev=${env.id} err=${String(err).slice(0, 200)}`,
        );
      }
      await withSpan(
        'ws.emit',
        { 'ws.event.type': wireType, 'ws.room': rooms.user(uid) },
        async () => {
          this.io!.to(rooms.user(uid)).emit(wireType, wire);
        },
      );
      this.metrics?.wsEventsEmittedTotal.labels(this.metrics.bucket('wsEventType', wireType)).inc();
    }
  }

  /**
   * S19: dm.* outbox 이벤트 → 와이어 (이벤트명, 페이로드) 매핑. 내부 라우팅용
   * recipients 는 제외하고 클라이언트 소비에 필요한 최소 필드만 담는다(dm:created
   * H-03 선례). 알 수 없는 dm.* 이벤트는 null 을 반환해 무음 드롭한다.
   */
  private buildDmWire(env: WsEnvelope): { wireType: string; wire: Record<string, unknown> } | null {
    const channelId = env.channelId ?? (env as { channelId?: string }).channelId;
    const base = { id: env.id, occurredAt: env.occurredAt, channelId };
    switch (env.type) {
      case 'dm.created':
        return {
          wireType: WS_EVENTS.DM_CREATED,
          wire: {
            ...base,
            type: WS_EVENTS.DM_CREATED,
            isGroup: (env as { isGroup?: boolean }).isGroup ?? false,
            participantIds: (env as { participantIds?: string[] }).participantIds ?? [],
          },
        };
      case 'dm.participant_added':
        return {
          wireType: WS_EVENTS.DM_PARTICIPANT_ADDED,
          wire: {
            ...base,
            type: WS_EVENTS.DM_PARTICIPANT_ADDED,
            addedUserIds: (env as { addedUserIds?: string[] }).addedUserIds ?? [],
          },
        };
      case 'dm.participant_removed':
        return {
          wireType: WS_EVENTS.DM_PARTICIPANT_REMOVED,
          wire: {
            ...base,
            type: WS_EVENTS.DM_PARTICIPANT_REMOVED,
            removedUserId: (env as { removedUserId?: string }).removedUserId ?? '',
            reason: (env as { reason?: string }).reason ?? 'left',
          },
        };
      case 'dm.owner_changed':
        return {
          wireType: WS_EVENTS.DM_OWNER_CHANGED,
          wire: {
            ...base,
            type: WS_EVENTS.DM_OWNER_CHANGED,
            ownerId: (env as { ownerId?: string }).ownerId ?? '',
          },
        };
      case 'dm.group_updated': {
        // S20 (FR-DM-05/06): 이름/아이콘 변경. displayName / iconUrl 은 변경분만
        // 실린다(둘 다 nullable·optional). 아이콘 삭제는 iconUrl=null 로 전달된다.
        const wire: Record<string, unknown> = {
          ...base,
          type: WS_EVENTS.DM_GROUP_UPDATED,
        };
        const rawDisplayName = (env as { displayName?: unknown }).displayName;
        if (rawDisplayName !== undefined) {
          wire.displayName = typeof rawDisplayName === 'string' ? rawDisplayName : null;
        }
        const rawIconUrl = (env as { iconUrl?: unknown }).iconUrl;
        if (rawIconUrl !== undefined) {
          wire.iconUrl = typeof rawIconUrl === 'string' ? rawIconUrl : null;
        }
        return { wireType: WS_EVENTS.DM_GROUP_UPDATED, wire };
      }
      default:
        return null;
    }
  }

  /**
   * S17 (FR-DM-19) friend.unblocked. 차단 해제 시 blocker(targetUserId)의
   * user:{userId} 룸으로 와이어 이벤트 `user:unblocked { unblockedUserId }` 를
   * emit 한다. 차단당한 쪽에는 보내지 않는다(비노출 — outbox payload 의
   * targetUserId 는 항상 blocker 본인). 클라이언트는 이 id 가 작성한 메시지의
   * 마스킹을 풀기 위해 현재 채널 메시지 캐시를 무효화/재로드한다. mention.** ·
   * dm.** 와 동일한 user-room fanout 패턴이다.
   */
  @OnEvent('friend.**')
  async onFriendEvent(env: WsEnvelope): Promise<void> {
    if (!this.io) return;
    if (env.type !== 'friend.unblocked') return; // request/accepted 는 me-activity 가 소비.
    const targetUserId = pickTargetUserId(env);
    // S17 NIT (poison-payload defense): unblockedUserId 는 outbox payload 스프레드로
    // 들어오므로 string 타입을 강제 검증한 뒤 early return 한다(오염/누락 방어).
    const rawUnblocked = (env as { unblockedUserId?: unknown }).unblockedUserId;
    if (typeof rawUnblocked !== 'string') return;
    const unblockedUserId = rawUnblocked;
    if (!targetUserId) return;
    const wire = {
      id: env.id,
      type: WS_EVENTS.USER_UNBLOCKED,
      occurredAt: env.occurredAt,
      unblockedUserId,
    };
    try {
      await this.replay.append('user', targetUserId, {
        id: env.id,
        type: WS_EVENTS.USER_UNBLOCKED,
        occurredAt: env.occurredAt,
        payload: wire,
      });
    } catch (err) {
      this.logger.warn(
        `[realtime] unblock replay append failed uid=${targetUserId} ev=${env.id} err=${String(err).slice(0, 200)}`,
      );
    }
    await withSpan(
      'ws.emit',
      { 'ws.event.type': WS_EVENTS.USER_UNBLOCKED, 'ws.room': rooms.user(targetUserId) },
      async () => {
        this.io!.to(rooms.user(targetUserId)).emit(WS_EVENTS.USER_UNBLOCKED, wire);
      },
    );
    this.metrics?.wsEventsEmittedTotal
      .labels(this.metrics.bucket('wsEventType', WS_EVENTS.USER_UNBLOCKED))
      .inc();
  }

  @OnEvent('workspace.**')
  async onWorkspaceEvent(env: WsEnvelope): Promise<void> {
    if (!env.workspaceId) return;
    // S72 fix-forward (reviewer H1 = realtime BLOCKER): ws:workspace_deleted /
    // ws:workspace_restored 를 핸들러 최상단(emitAndBuffer 의 느린 Redis append await
    // 이전, 첫 await 전 동기 시점)에서 먼저 룸으로 emit 한다. 같은 EventEmitter2
    // 이벤트(workspace.deleted)를 MembershipRevocationListener 가 받아 룸 소켓을
    // disconnectSockets 하므로(워크스페이스 스코프 이벤트는 reconnect replay 안 됨 —
    // realtime.gateway 명시), emit 이 emitAndBuffer 뒤에 있으면 disconnect 가 먼저
    // 이겨 멤버가 알림을 유실한다. 동기 emit 으로 disconnect 보다 먼저 도달을 보장한다.
    // (FE 의 connection.error{code:'workspace_deleted'} 핸들러가 disconnect 가 이겨도
    //  redirect+무효화하는 이중 안전망을 useRealtimeConnection 에 별도 추가했다.)
    this.emitWorkspaceLifecycleWire(env);
    await this.emitAndBuffer('workspace', env.workspaceId, env);
    // S63 fix-forward (contract D-1 = BLOCKER/MAJOR): kick/ban 은 PRD 가 명시한 콜론
    // wire 이벤트 member:kicked / member:banned 를 워크스페이스 룸으로 추가 emit 한다.
    // 서버 내부 outbox eventType 은 dot 표기(workspace.member.kicked / .banned)라
    // 위 emitAndBuffer 가 dot 이름으로 워크스페이스 룸에 보내지만, FE dispatcher 의
    // 콜론 핸들러(멤버 목록/차단 목록 캐시 무효화 + 본인 토스트)가 받을 콜론 이름은
    // 별도로 emit 해야 한다(message:embed_updated / reaction:updated dot→colon 선례).
    // 본인 disconnect 는 아래 kickUserEverywhere 가 처리하므로 여기선 룸 fanout 만 한다.
    if (
      this.io &&
      (env.type === 'workspace.member.kicked' || env.type === 'workspace.member.banned')
    ) {
      const wireType =
        env.type === 'workspace.member.kicked' ? WS_EVENTS.MEMBER_KICKED : WS_EVENTS.MEMBER_BANNED;
      const wire = {
        workspaceId: env.workspaceId,
        userId: (env as { userId?: string }).userId ?? '',
        actorId: (env as { actorId?: string }).actorId ?? '',
      };
      this.io.to(rooms.workspace(env.workspaceId)).emit(wireType, wire);
      this.metrics?.wsEventsEmittedTotal.labels(this.metrics.bucket('wsEventType', wireType)).inc();
    }
    // S70 (FR-W12): 멤버 이탈(임시멤버 자동 강퇴 포함)은 PRD 가 명시한 콜론 wire 이벤트
    // ws:member_left { workspaceId, userId, reason } 를 워크스페이스 룸으로 추가 emit 한다.
    // 서버 내부 outbox eventType 은 dot 표기(workspace.member.left)라 위 emitAndBuffer 가
    // dot 이름으로 워크스페이스 룸에 보내지만, FE dispatcher 의 콜론 핸들러(멤버 목록 캐시
    // 무효화)가 받을 콜론 이름은 별도로 emit 한다(member:kicked dot→colon 선례). reason 은
    // payload 에 실려온 값을 쓰되, 미지정(일반 leave)이면 'leave' 로 폴백한다. temp_expired
    // 강퇴는 TempEvictProcessor 가 reason='temp_expired' 로 기록한다.
    if (this.io && env.type === 'workspace.member.left') {
      const rawReason = (env as { reason?: unknown }).reason;
      const reason =
        rawReason === 'temp_expired' || rawReason === 'kick' || rawReason === 'leave'
          ? rawReason
          : 'leave';
      const wire = {
        workspaceId: env.workspaceId,
        userId: (env as { userId?: string }).userId ?? '',
        reason,
      };
      this.io.to(rooms.workspace(env.workspaceId)).emit(WS_EVENTS.MEMBER_LEFT, wire);
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.MEMBER_LEFT))
        .inc();
    }
    // Member-level events ALSO go to the target user's private room so we can
    // immediately kick a removed member whose socket is on a different node.
    const targetUserId = pickTargetUserId(env);
    if (targetUserId && this.io) {
      this.io.to(rooms.user(targetUserId)).emit(env.type, env);
    }
    // task-019-B (018-follow-3): workspace.member.joined means the
    // target user is now in a new workspace + its channels; refresh
    // their sockets' channelIds if any are connected.
    if (env.type === 'workspace.member.joined' && targetUserId) {
      await this.gateway.refreshUserChannelIds(targetUserId).catch(() => undefined);
    }
    // Kick is handled here (not in a sibling @OnEvent) to avoid handler-order
    // surprises with EventEmitter2 wildcard mode.
    // S63 (FR-RM05·06): kick(workspace.member.kicked)·ban(workspace.member.banned)
    // 도 즉시 소켓을 끊는다(세션 무효화). kicked 은 재가입 가능, banned 는 영구 차단
    // 이지만 disconnect 동작은 동일하다(BannedMember 체크가 재진입을 막는다).
    if (
      env.type === 'workspace.member.removed' ||
      env.type === 'workspace.member.left' ||
      env.type === 'workspace.member.kicked' ||
      env.type === 'workspace.member.banned'
    ) {
      if (targetUserId) {
        // Defer briefly so the event we just emitted reaches the wire before
        // the socket is closed; otherwise the client loses the disconnect
        // reason.
        setTimeout(() => {
          void this.gateway.kickUserEverywhere(targetUserId, env.type).catch(() => undefined);
        }, 50);
      }
    }
  }

  /**
   * S72 (FR-W15): 워크스페이스 소프트 삭제/복원의 콜론 wire 이벤트를 워크스페이스 룸으로
   * emit 한다. 서버 내부 outbox eventType 은 dot 표기(workspace.deleted / workspace.restored)
   * 라, FE dispatcher 의 콜론 핸들러(내 워크스페이스 목록 무효화 + 현재 워크스페이스면
   * 리다이렉트)가 받을 콜론 이름은 별도로 emit 한다(member:kicked / ws:member_left dot→colon
   * 선례). deleted 는 actorId + deleteAt(grace 종료 시각)을, restored 는 actorId 를 싣는다.
   *
   * S72 fix-forward (reviewer H1 = realtime BLOCKER): 이 emit 은 onWorkspaceEvent 의 첫
   * await(emitAndBuffer 의 Redis append) 이전 동기 시점에서 호출돼, 같은 EventEmitter2
   * 이벤트로 disconnectSockets 하는 MembershipRevocationListener 보다 먼저 룸에 도달한다.
   * 워크스페이스 스코프 이벤트는 reconnect replay 대상이 아니라(gateway 명시) disconnect 가
   * 먼저 이기면 영구 유실이므로 순서 보장이 필요하다.
   *
   * S72 fix-forward (reviewer L3 = cheap correctness): 종전 `actorId ?? ''` /
   * `deleteAt ?? new Date().toISOString()` fallback 을 제거했다 — 빈 문자열은 events.ts 의
   * min(1) 스키마를, 가짜 현재시각 deleteAt 은 의미를 깨 FE safeParse 가 무음 드롭한다.
   * softDelete/restore 서비스가 actorId·deleteAt 을 항상 채우므로 envelope 값을 직접 쓰되,
   * 만에 하나 결손(타입 불량)이면 빈 wire 를 보내 무음 드롭시키느니 명시적으로 스킵+경고한다.
   */
  private emitWorkspaceLifecycleWire(env: WsEnvelope): void {
    if (!this.io || !env.workspaceId) return;
    if (env.type === 'workspace.deleted') {
      const actorId = (env as { actorId?: unknown }).actorId;
      const deleteAt = (env as { deleteAt?: unknown }).deleteAt;
      if (typeof actorId !== 'string' || !actorId || typeof deleteAt !== 'string' || !deleteAt) {
        this.logger.warn(
          `[realtime] workspace.deleted envelope missing actorId/deleteAt ev=${env.id} — skipping ws wire emit`,
        );
        return;
      }
      const wire = { workspaceId: env.workspaceId, actorId, deleteAt };
      this.io.to(rooms.workspace(env.workspaceId)).emit(WS_EVENTS.WORKSPACE_DELETED, wire);
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.WORKSPACE_DELETED))
        .inc();
      return;
    }
    if (env.type === 'workspace.restored') {
      const actorId = (env as { actorId?: unknown }).actorId;
      if (typeof actorId !== 'string' || !actorId) {
        this.logger.warn(
          `[realtime] workspace.restored envelope missing actorId ev=${env.id} — skipping ws wire emit`,
        );
        return;
      }
      const wire = { workspaceId: env.workspaceId, actorId };
      this.io.to(rooms.workspace(env.workspaceId)).emit(WS_EVENTS.WORKSPACE_RESTORED, wire);
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.WORKSPACE_RESTORED))
        .inc();
    }
  }

  /**
   * task-019-B: refresh every workspace member's socket state so they
   * pick up a new channel immediately. Queries the workspace's member
   * list and fans out to each. Rare event (channel.created); no
   * throttling needed. Exceptions per-user are swallowed so one stale
   * socket can't block the rest.
   */
  private async refreshChannelIdsForWorkspace(workspaceId: string): Promise<void> {
    if (!this.io) return;
    const sockets = await this.io.in(rooms.workspace(workspaceId)).fetchSockets();
    if (sockets.length === 0) return;
    const seen = new Set<string>();
    for (const s of sockets) {
      const state = (s as unknown as { data: { state?: { user: { userId: string } } } }).data.state;
      const uid = state?.user?.userId;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      await this.gateway.refreshUserChannelIds(uid).catch(() => undefined);
    }
  }

  private async emitAndBuffer(
    scope: 'channel' | 'workspace',
    id: string,
    env: WsEnvelope,
  ): Promise<void> {
    if (!this.io) return;
    // FR-RT-06: 채널 스코프 이벤트마다 채널별 단조 seq 를 발급해 페이로드에
    // 싣습니다(갭 감지 힌트). Redis 장애 시 ChannelSeqService 가 SEQ_SENTINEL 을
    // 반환하므로 throw 없이 fanout 이 계속됩니다. workspace 스코프 이벤트는
    // 채널 갭 감지 대상이 아니라 seq 를 붙이지 않습니다. 같은 env 가 channel +
    // workspace 룸으로 두 번 emit 되는 channel.* 이벤트의 경우, seq 는 채널
    // 발급분으로 한 번 채워지며 workspace 재emit 에도 그대로 실립니다(클라
    // 워크스페이스 뷰는 seq 를 쓰지 않으므로 무해).
    if (scope === 'channel' && typeof env.seq !== 'number') {
      env.seq = await this.seq.next(id);
    }
    try {
      await this.replay.append(scope, id, {
        id: env.id,
        type: env.type,
        occurredAt: env.occurredAt,
        payload: env,
      });
    } catch (err) {
      // Replay miss is non-fatal — the outbox row is still the source of truth.
      this.logger.warn(
        `[realtime] replay append failed scope=${scope} id=${id} ev=${env.id} err=${String(err).slice(0, 200)}`,
      );
    }
    const room = scope === 'channel' ? rooms.channel(id) : rooms.workspace(id);
    await withSpan('ws.emit', { 'ws.event.type': env.type, 'ws.room': room }, async () => {
      this.io!.to(room).emit(env.type, env);
    });
    // task-016-B (009-nit-4): bucket env.type through the allowlist.
    this.metrics?.wsEventsEmittedTotal.labels(this.metrics.bucket('wsEventType', env.type)).inc();
    // Fan-out latency = occurredAt → now (emit). The per-channel replay
    // append + socket.io emit both happen in this frame, so `now` captures
    // the wire handoff moment.
    const fanoutSec = (Date.now() - new Date(env.occurredAt).getTime()) / 1000;
    if (Number.isFinite(fanoutSec) && fanoutSec >= 0) {
      this.metrics?.wsMessageFanoutLatencySeconds.observe(fanoutSec);
    }
  }
}
