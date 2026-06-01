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
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  private get io(): Server | null {
    return this.gateway.server ?? null;
  }

  @OnEvent('message.**')
  async onMessageEvent(env: WsEnvelope): Promise<void> {
    const chId = env.channelId ?? (env as { message?: { channelId?: string } }).message?.channelId;
    if (!chId) return;
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
    try {
      await this.replay.append('user', targetUserId, {
        id: env.id,
        type: env.type,
        occurredAt: env.occurredAt,
        payload: env,
      });
    } catch (err) {
      this.logger.warn(
        `[realtime] replay append failed scope=user id=${targetUserId} ev=${env.id} err=${String(err).slice(0, 200)}`,
      );
    }
    await withSpan(
      'ws.emit',
      { 'ws.event.type': env.type, 'ws.room': rooms.user(targetUserId) },
      async () => {
        this.io!.to(rooms.user(targetUserId)).emit(env.type, env);
      },
    );
    // task-016-B (009-nit-4): bucket env.type through the allowlist.
    this.metrics?.wsEventsEmittedTotal.labels(this.metrics.bucket('wsEventType', env.type)).inc();
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
    await this.emitAndBuffer('workspace', env.workspaceId, env);
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
    if (env.type === 'workspace.member.removed' || env.type === 'workspace.member.left') {
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
