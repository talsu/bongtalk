import { Logger, Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  WS_EVENTS,
  type ChannelJoinedPayload,
  type ReadStateUpdatedPayload,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { UnreadService } from '../channels/unread.service';
import { WsAuthMiddleware, WsUserPayload } from './handshake/ws-auth.middleware';
import { RoomManagerService } from './rooms/room-manager.service';
import { PresenceService } from './presence/presence.service';
import { PresenceThrottler } from './presence/presence-throttler';
import { TypingService } from './typing/typing.service';
import { ReplayBufferService } from './projection/replay-buffer.service';
import { ChannelSeqService } from './projection/channel-seq.service';
import { rooms } from './rooms/room-names';
import { MetricsService } from '../observability/metrics/metrics.service';

type SocketState = {
  user: WsUserPayload;
  workspaceIds: string[];
  channelIds: string[];
};

/**
 * Central WS gateway. Lifecycle:
 *   afterInit   → install JWT handshake middleware
 *   connection  → verify already done by middleware; snapshot memberships,
 *                 auto-join workspace + channel rooms, register presence,
 *                 replay missed events if `x-last-event-id` was provided
 *   disconnect  → presence.unregister; if last session for this user, emit
 *                 presence.updated (throttled) for each workspace
 *
 * The gateway is intentionally thin — room routing lives in
 * OutboxToWsSubscriber and presence state lives in PresenceService. Keeping
 * this file focused on lifecycle + a handful of client→server events makes
 * it reviewable on one screen.
 */
// FR-RT-20: websocket-only transport (HTTP long-polling disabled), tuned
// engine.io heartbeat, and a 1 MB max frame. The web client
// (apps/web/src/lib/socket.ts) already requests transports:['websocket'],
// so disabling polling server-side is non-breaking. The Node heap flag
// (--max-old-space-size) is a runtime/CMD concern → compose follow-up,
// out of code scope.
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1024 * 1024,
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly wsAuth: WsAuthMiddleware,
    private readonly roomMgr: RoomManagerService,
    private readonly presence: PresenceService,
    private readonly throttler: PresenceThrottler,
    private readonly replay: ReplayBufferService,
    private readonly typing: TypingService,
    private readonly prisma: PrismaService,
    // S10 fix-forward (MAJOR #2): connect 시 채널별 seq baseline 스냅샷 발행기.
    private readonly seq: ChannelSeqService,
    // S11 (FR-RT-13/14/19): channel:read 핸들러가 monotonic upsert + unread
    // 재계산에 사용. read-sync 공식 단일 출처(unread.service)를 재사용한다.
    private readonly unread: UnreadService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  afterInit(server: Server): void {
    server.use(this.wsAuth.middleware());
    // EventEmitter2 raised the listener count in task-003 but some dispatcher
    // bursts (10+ events in one tick) can approach the default 10-listener
    // warning on the Socket.IO server side — bump it.
    server.sockets.setMaxListeners(50);
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = client.data.user as WsUserPayload | undefined;
    if (!user) {
      this.metrics?.wsConnectionsTotal.labels('rejected_auth').inc();
      client.disconnect(true);
      return;
    }
    this.metrics?.wsConnectionsTotal.labels('accepted').inc();
    this.metrics?.wsConnectionsActive.inc();
    const {
      rooms: joinable,
      workspaceIds,
      channelIds,
    } = await this.roomMgr.roomsForUser(user.userId);
    await client.join(joinable);
    client.data.state = { user, workspaceIds, channelIds } satisfies SocketState;

    // task-019-C: consult the user's static DnD preference so the
    // presence SET correctly reflects DnD on connect, not just after
    // a PATCH.
    const userRow = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { presencePreference: true },
    });
    const preference = (userRow?.presencePreference ?? 'auto') as 'auto' | 'dnd';

    await this.presence.register({
      sessionId: user.sessionId,
      userId: user.userId,
      workspaceIds,
      preference,
    });
    this.metrics?.wsPresenceSessionsActive.inc();

    // FR-RT-01: signal the client that rooms are joined + presence is
    // registered. Emitted before any replay so the client can flip its
    // connection state to "ready" prior to catch-up events landing.
    client.emit(WS_EVENTS.CONNECTION_READY, {
      userId: user.userId,
      sessionId: user.sessionId,
    });

    // S10 fix-forward (MAJOR #2): connect 직후 eager-join 한 채널마다 현재 seq
    // 스냅샷을 baseline 으로 내려보냅니다. 이게 없으면 이번 세션에 라이브
    // 메시지가 없던 채널은 클라 SeqTracker 가 비어 재연결 시 gap-fetch 대상에서
    // 통째로 빠집니다("절전 후 재연결" 케이스). 부하 가드: 채널 seq 는 단일
    // MGET 으로 묶어 연결당 1 라운드트립, 채널당 emit 1회뿐입니다. unread/
    // lastMessage 등 무거운 필드는 싣지 않습니다(현재 소비처 없음 + per-channel
    // 서브쿼리 폭주 회피 — 스키마에서 optional).
    const seqByChannel = await this.seq.currentMany(channelIds);
    for (const chId of channelIds) {
      const snapshot: ChannelJoinedPayload = {
        channelId: chId,
        seq: seqByChannel.get(chId) ?? 0,
      };
      client.emit(WS_EVENTS.CHANNEL_JOINED, snapshot);
    }

    // Schedule a throttled presence broadcast per workspace the user just
    // joined — the throttler guarantees one emit per 2s window per workspace.
    for (const wsId of workspaceIds) {
      this.schedulePresenceBroadcast(wsId);
    }

    // If client passed an x-last-event-id header, replay anything newer than
    // that per-channel. We do not replay workspace-scoped events to the
    // reconnecting client — workspace membership/channel changes are much
    // rarer and reloading the channel list is cheap.
    const lastEventId = pickLastEventId(client);
    if (lastEventId) {
      let replayed = 0;
      // S10 fix-forward (MAJOR #3): truncated 를 채널별로 수집합니다. 예전엔
      // boolean 단일 플래그라 한 채널의 버퍼 미스가 `replay.truncated` 단일
      // emit → 클라가 추적 중인 *모든* 채널을 gap-fetch 하는 N채널 폭주를
      // 유발했습니다. 이제 어떤 채널이 truncated 됐는지 id 목록으로 실어
      // 클라가 해당 채널만 gap-fetch 하도록 합니다.
      const truncatedChannelIds: string[] = [];
      for (const chId of channelIds) {
        const res = await this.replay.rangeAfter('channel', chId, lastEventId);
        if (res.truncated) {
          truncatedChannelIds.push(chId);
          continue;
        }
        for (const ev of res.events) {
          client.emit(ev.type, ev.payload);
          replayed++;
        }
      }
      if (truncatedChannelIds.length > 0) {
        // `lastEventId` 는 진단용으로 유지(기존 구 클라 호환). `channelIds` 가
        // 신규 라우팅 키입니다.
        client.emit('replay.truncated', { lastEventId, channelIds: truncatedChannelIds });
      }
      client.emit('replay.complete', { replayed });
    }

    this.logger.log(
      `[ws] +connect user=${user.userId} sid=${user.sessionId} rooms=${joinable.length} replay=${lastEventId ?? '-'}`,
    );
  }

  async handleDisconnect(client: Socket, reason?: string): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    this.metrics?.wsConnectionsActive.dec();
    this.metrics?.wsDisconnectionsTotal
      .labels(this.metrics.bucket('wsDisconnectReason', normalizeReason(reason)))
      .inc();
    if (!state) return;
    this.metrics?.wsPresenceSessionsActive.dec();
    const { goneFrom } = await this.presence.unregister({
      sessionId: state.user.sessionId,
      userId: state.user.userId,
      workspaceIds: state.workspaceIds,
    });
    for (const wsId of goneFrom) {
      this.schedulePresenceBroadcast(wsId);
    }
    // task-018-F: also clear the user from any typing sets so the
    // indicator drops before the TTL (up to 5 s faster).
    const clearedTypingChannels = await this.typing.dropForUser(
      state.user.userId,
      state.channelIds,
    );
    for (const chId of clearedTypingChannels) {
      const typingUserIds = await this.typing.currentlyTyping(chId);
      this.server.to(rooms.channel(chId)).emit('typing.updated', {
        channelId: chId,
        typingUserIds,
      });
    }
    this.logger.log(
      `[ws] -disconnect user=${state.user.userId} sid=${state.user.sessionId} goneFromWs=${goneFrom.length} clearedTyping=${clearedTypingChannels.length}`,
    );
  }

  @SubscribeMessage('presence:ping')
  async onPing(@ConnectedSocket() client: Socket): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    const ok = await this.presence.heartbeat(state.user.sessionId);
    if (!ok) {
      // Session TTL expired — force reconnect so register() runs again.
      client.disconnect(true);
    }
  }

  @SubscribeMessage('channel:focus')
  async onFocus(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId?: string },
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state || !body?.channelId) return;
    if (!state.channelIds.includes(body.channelId)) return; // not a member
    await this.presence.setCurrentChannel(state.user.sessionId, body.channelId);
  }

  @SubscribeMessage('channel:blur')
  async onBlur(@ConnectedSocket() client: Socket): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    await this.presence.setCurrentChannel(state.user.sessionId, null);
  }

  @SubscribeMessage('typing.ping')
  async onTypingPing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId?: string },
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state || !body?.channelId) return;
    if (!state.channelIds.includes(body.channelId)) return; // not a channel member
    const typingUserIds = await this.typing.ping(state.user.userId, body.channelId);
    if (!typingUserIds) return; // throttled — a recent broadcast already named us
    this.server.to(rooms.channel(body.channelId)).emit('typing.updated', {
      channelId: body.channelId,
      typingUserIds,
    });
  }

  /**
   * task-021-R1-typing-stale-on-clear: fires when the client's composer
   * draft becomes empty. Removes the user from the typing set + clears
   * the per-(user, channel) throttle so the next keystroke isn't
   * silently suppressed for up to 3 s. Broadcasts the refreshed set.
   */
  @SubscribeMessage('typing.stop')
  async onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId?: string },
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state || !body?.channelId) return;
    if (!state.channelIds.includes(body.channelId)) return;
    const res = await this.typing.stop(state.user.userId, body.channelId);
    if (!res.changed) return;
    this.server.to(rooms.channel(body.channelId)).emit('typing.updated', {
      channelId: body.channelId,
      typingUserIds: res.members,
    });
  }

  /**
   * S11 (FR-RT-13/19): channel:read WS 핸들러. 두 관심사를 다룬다.
   *
   *  - `eventId` (legacy / reconnect replay): lastReadEventId 포인터를
   *    갱신한다. 기존 동작 보존 — replay-buffer 의 "X 이후 재생" 키.
   *  - `lastReadMessageId` (S11): unread.service.ackRead 로 monotonic
   *    (createdAt, id) 튜플 upsert + unread 재계산 후
   *    `read_state:updated` 를 user:{userId} 룸으로 emit. HTTP /ack 와
   *    동일한 단일 공식을 재사용해 두 경로가 항상 정합한다(퇴행 무시).
   */
  @SubscribeMessage('channel:read')
  async onRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId?: string; eventId?: string; lastReadMessageId?: string },
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state || !body?.channelId) return;
    if (!state.channelIds.includes(body.channelId)) return;

    // Reconnect-replay pointer (unchanged 005 behaviour).
    if (body.eventId) {
      await this.prisma.userChannelReadState.upsert({
        where: {
          userId_channelId: { userId: state.user.userId, channelId: body.channelId },
        },
        create: {
          userId: state.user.userId,
          channelId: body.channelId,
          lastReadEventId: body.eventId,
        },
        update: { lastReadEventId: body.eventId, lastReadAt: new Date() },
      });
    }

    // S11 message-cursor ack + emit.
    if (body.lastReadMessageId) {
      try {
        const payload = await this.unread.ackRead({
          userId: state.user.userId,
          channelId: body.channelId,
          lastReadMessageId: body.lastReadMessageId,
        });
        this.emitReadStateUpdated(state.user.userId, payload);
      } catch (err) {
        // A bad message id (not in this channel) is a client error, not a
        // gateway fault — swallow so one stray ack can't disrupt the socket.
        this.logger.warn(
          `[ws] channel:read ack ignored user=${state.user.userId} ch=${body.channelId} err=${String(err).slice(0, 160)}`,
        );
      }
    }
  }

  /**
   * S11 (FR-RT-13): emit `read_state:updated` to the user's private room.
   * Shared by the WS channel:read handler and the HTTP POST /ack path so a
   * read on one device syncs the badge on the user's other devices/tabs.
   */
  emitReadStateUpdated(userId: string, payload: ReadStateUpdatedPayload): void {
    if (!this.server) return;
    this.server.to(rooms.user(userId)).emit(WS_EVENTS.READ_STATE_UPDATED, payload);
    this.metrics?.wsEventsEmittedTotal
      .labels(this.metrics.bucket('wsEventType', WS_EVENTS.READ_STATE_UPDATED))
      .inc();
  }

  /**
   * task-019-B (018-follow-3): refresh SocketState.channelIds for every
   * currently-connected socket belonging to `userId`. Invoked after
   * channel.created / workspace.member.joined fan-out so the user's
   * in-flight sockets can typing.ping / channel:read on the newly-
   * member channels without a reconnect. Safe for other nodes — if
   * the user has no socket on this node, the refresh is a no-op.
   */
  async refreshUserChannelIds(userId: string): Promise<void> {
    if (!this.server) return;
    const userRoomSockets = await this.server.in(rooms.user(userId)).fetchSockets();
    if (userRoomSockets.length === 0) return;
    const fresh = await this.roomMgr.roomsForUser(userId);
    for (const s of userRoomSockets) {
      const data = (s as unknown as { data: { state?: SocketState } }).data;
      if (!data.state) continue;
      const already = new Set(data.state.channelIds);
      const toJoin = fresh.channelIds.filter((id) => !already.has(id));
      if (toJoin.length > 0) {
        await s.join(toJoin.map((id) => rooms.channel(id)));
      }
      data.state.channelIds = fresh.channelIds;
      data.state.workspaceIds = fresh.workspaceIds;
    }
  }

  /** Kick every socket owned by a user (all nodes). Used on member removal. */
  async kickUserEverywhere(userId: string, reason: string): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.in(rooms.user(userId)).fetchSockets();
    for (const s of sockets) {
      s.emit('connection.error', { code: reason });
    }
    this.server.in(rooms.user(userId)).disconnectSockets(true);
  }

  // ----- private

  private schedulePresenceBroadcast(workspaceId: string): void {
    this.throttler.schedule(workspaceId, async () => {
      const [online, dnd] = await Promise.all([
        this.presence.onlineIn(workspaceId),
        this.presence.dndIn(workspaceId),
      ]);
      this.server.to(rooms.workspace(workspaceId)).emit('presence.updated', {
        workspaceId,
        onlineUserIds: online,
        // task-019-C: DnD subset so the client can render the dnd dot.
        dndUserIds: dnd,
      });
    });
  }

  /**
   * Expose the broadcast scheduler for controllers that need to fan
   * out a presence change immediately (e.g. PATCH /me/presence).
   */
  schedulePresenceBroadcastPublic(workspaceId: string): void {
    this.schedulePresenceBroadcast(workspaceId);
  }

  /**
   * task-045 iter7: 사용자 프로필 변경 broadcast (custom status 등).
   * 사용자의 모든 워크스페이스 룸 + DM 피어 룸으로 emit. throttle 은
   * follow-up — 빈도가 낮은 상태 변경이라 우선 raw emit.
   */
  broadcastUserProfileUpdate(args: {
    userId: string;
    workspaceIds: string[];
    customStatus: string | null;
  }): void {
    const payload = {
      userId: args.userId,
      customStatus: args.customStatus,
    };
    for (const wsId of args.workspaceIds) {
      this.server.to(rooms.workspace(wsId)).emit('user.profile.updated', payload);
    }
  }
}

function pickLastEventId(client: Socket): string | null {
  const header = client.handshake.headers['x-last-event-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = client.handshake.auth as { lastEventId?: string } | undefined;
  if (auth?.lastEventId && typeof auth.lastEventId === 'string') return auth.lastEventId;
  return null;
}

/**
 * Maps Socket.IO / engine.io disconnect reason strings to our bounded enum.
 * Common values: `transport close`, `transport error`, `ping timeout`,
 * `client namespace disconnect`, `server namespace disconnect`,
 * `forced close`, `server shutting down`.
 */
function normalizeReason(raw: string | undefined): string {
  if (!raw) return 'client';
  const s = raw.toLowerCase();
  if (s.includes('transport error') || s.includes('ping timeout')) return 'transport_error';
  if (s.includes('server namespace') || s.includes('forced close') || s.includes('server shutting'))
    return 'server_kick';
  if (s.includes('membership')) return 'membership_revoked';
  return 'client';
}
