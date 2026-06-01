import { Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
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
  PRESENCE_OFFLINE_GRACE,
  PRESENCE_IDLE_SWEEP_INTERVAL_MS,
  PresenceSubscribePayloadSchema,
  PresenceActivityPayloadSchema,
  type ChannelJoinedPayload,
  type PresenceBulkPayload,
  type ReadStateUpdatedPayload,
  type WorkspacePresenceUpdatedPayload,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { UnreadService } from '../channels/unread.service';
import { WsAuthMiddleware, WsUserPayload } from './handshake/ws-auth.middleware';
import { RoomManagerService } from './rooms/room-manager.service';
import { PresenceService } from './presence/presence.service';
import { PresenceThrottler } from './presence/presence-throttler';
import { PresenceGraceTimers } from './presence/presence-grace-timers';
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
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  // S25 (FR-RT-10): workspaces with at least one connection seen on this node.
  // The idle sweep walks these to detect ONLINE→IDLE crossings and re-broadcast.
  private readonly activeWorkspaces = new Set<string>();
  // Last idle set we broadcast per workspace, so the sweep only re-broadcasts
  // when the idle membership actually changed (avoids a 30s broadcast storm).
  private readonly lastIdleSet = new Map<string, string>();
  private idleSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wsAuth: WsAuthMiddleware,
    private readonly roomMgr: RoomManagerService,
    private readonly presence: PresenceService,
    private readonly throttler: PresenceThrottler,
    private readonly graceTimers: PresenceGraceTimers,
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
    this.startIdleSweep();
  }

  /**
   * S25 (FR-RT-10): periodic ONLINE→IDLE detector. A user who stops sending
   * `presence:activity` has no event to trigger a broadcast, so we poll every
   * PRESENCE_IDLE_SWEEP_INTERVAL_MS (default 30s). Only re-broadcasts a
   * workspace whose idle membership changed since the last sweep, so an idle
   * population doesn't cause a 30s broadcast storm.
   */
  private startIdleSweep(): void {
    if (this.idleSweepTimer) return;
    // S25 fix-forward(cheap · NaN 가드): 단일 상수 기본값 + finite/>0 가드. 잘못
    // 설정된 env(NaN/음수)가 setInterval(0) busy-loop 를 만들지 않도록 한다.
    const raw = Number(
      process.env.PRESENCE_IDLE_SWEEP_INTERVAL_MS ?? PRESENCE_IDLE_SWEEP_INTERVAL_MS,
    );
    const intervalMs = Number.isFinite(raw) && raw > 0 ? raw : PRESENCE_IDLE_SWEEP_INTERVAL_MS;
    const t = setInterval(() => void this.idleSweepTick().catch(() => undefined), intervalMs);
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
      (t as unknown as { unref: () => void }).unref();
    }
    this.idleSweepTimer = t;
  }

  private async idleSweepTick(): Promise<void> {
    for (const wsId of this.activeWorkspaces) {
      const online = await this.presence.onlineIn(wsId);
      if (online.length === 0) {
        this.activeWorkspaces.delete(wsId);
        this.lastIdleSet.delete(wsId);
        continue;
      }
      const idle = await this.presence.idleIn(online);
      const key = idle.slice().sort().join(',');
      if (key !== (this.lastIdleSet.get(wsId) ?? '')) {
        this.lastIdleSet.set(wsId, key);
        this.schedulePresenceBroadcast(wsId);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
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

    // task-019-C / S25: consult the user's static preference so the presence
    // SET correctly reflects DnD / invisible on connect, not just after a
    // PATCH. 'invisible' joins no observable SET (only self sees them).
    const userRow = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { presencePreference: true },
    });
    const preference = (userRow?.presencePreference ?? 'auto') as 'auto' | 'dnd' | 'invisible';

    // S25 (FR-P02): a reconnect inside the 35s grace window cancels the
    // pending OFFLINE timer so no OFFLINE broadcast fires and the previous
    // status is restored immediately.
    this.graceTimers.cancel(user.userId);

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
      // S25 (FR-RT-10): remember this workspace so the idle sweep watches it.
      this.activeWorkspaces.add(wsId);
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
    const { lastSessionGone } = await this.presence.unregister({
      sessionId: state.user.sessionId,
      userId: state.user.userId,
      workspaceIds: state.workspaceIds,
    });
    // S25 (FR-P02): only the LAST session triggers the OFFLINE path, and even
    // then we defer for PRESENCE_OFFLINE_GRACE seconds. A reconnect inside the
    // window cancels this timer (see handleConnection). If it elapses, finalize
    // OFFLINE + broadcast per workspace. Multi-device (FR-RT-11): other live
    // sessions keep lastSessionGone false → user stays ONLINE, no timer.
    if (lastSessionGone) {
      const { userId } = state.user;
      const wsIds = [...state.workspaceIds];
      // S25 fix-forward(B2): capture the grace epoch at arm time. A reconnect —
      // even on a different node — INCRements it via register(), so when the
      // timer fires finalizeOffline aborts on an epoch mismatch. This is the
      // cross-node complement to the process-local cancel() in handleConnection,
      // which only fires on the node that armed the timer.
      const armedEpoch = await this.presence.currentGraceEpoch(userId);
      this.graceTimers.arm(userId, this.offlineGraceMs(), async () => {
        const { goneFrom } = await this.presence.finalizeOffline(userId, wsIds, armedEpoch);
        for (const wsId of goneFrom) this.schedulePresenceBroadcast(wsId);
      });
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
      `[ws] -disconnect user=${state.user.userId} sid=${state.user.sessionId} lastSession=${lastSessionGone} clearedTyping=${clearedTypingChannels.length}`,
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

  /**
   * S25 (FR-RT-10): client `presence:activity`. The web client throttles this
   * to at most 1/30s on mousemove/keydown while focused. The server refreshes
   * last-activity; if the user was IDLE this transitions them back to ONLINE,
   * which we surface via a throttled workspace broadcast. DnD/invisible users
   * are unaffected (effectiveStatus keeps their status regardless of activity).
   */
  @SubscribeMessage(WS_EVENTS.PRESENCE_ACTIVITY)
  async onActivity(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    // S25 fix-forward(security HIGH · WS Zod): actually run safeParse (was a
    // bare type-hint). A non-conforming payload is rejected silently — activity
    // is a high-frequency hint, so a malformed frame must never throw.
    if (!PresenceActivityPayloadSchema.safeParse(body ?? {}).success) return;
    const { wasIdle } = await this.presence.touchActivity(state.user.userId);
    if (!wasIdle) return; // online → online, nothing to broadcast
    // IDLE → ONLINE: re-broadcast so observers drop the idle dot.
    for (const wsId of state.workspaceIds) {
      this.schedulePresenceBroadcast(wsId);
    }
  }

  /**
   * S25 (FR-RT-12): client `presence:subscribe { userIds }`. Reply immediately
   * with `presence:bulk` carrying each user's masked status. INVISIBLE → OFFLINE
   * for everyone except the subscriber themselves (maskPresenceForViewer single
   * point inside PresenceService.bulkFor).
   *
   * S25 fix-forward(security):
   *  - CRITICAL authz: a subscriber may only learn the presence of users they
   *    share a workspace OR a DM channel with. We intersect the requested ids
   *    with the subscriber's relationship set BEFORE bulkFor — unrelated ids are
   *    dropped entirely (no presence leak / user enumeration). The subscriber
   *    themselves is always allowed (self view).
   *  - HIGH DoS: userIds is safeParse'd against PresenceSubscribePayloadSchema
   *    (max 500). A non-conforming / oversized payload yields an empty reply
   *    instead of a per-user Redis fan-out.
   */
  @SubscribeMessage(WS_EVENTS.PRESENCE_SUBSCRIBE)
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    const empty: PresenceBulkPayload = { presences: [] };
    const parsed = PresenceSubscribePayloadSchema.safeParse(body);
    if (!parsed.success) {
      client.emit(WS_EVENTS.PRESENCE_BULK, empty);
      return;
    }
    const requested = [...new Set(parsed.data.userIds)];
    if (requested.length === 0) {
      client.emit(WS_EVENTS.PRESENCE_BULK, empty);
      return;
    }
    const allowed = await this.authorizePresenceTargets(state, requested);
    if (allowed.length === 0) {
      client.emit(WS_EVENTS.PRESENCE_BULK, empty);
      return;
    }
    const presences = await this.presence.bulkFor(state.user.userId, allowed);
    const payload: PresenceBulkPayload = { presences };
    client.emit(WS_EVENTS.PRESENCE_BULK, payload);
  }

  /**
   * S25 fix-forward(security CRITICAL · presence authz): given the subscriber's
   * socket state and the requested user ids, return only the ids the subscriber
   * is allowed to observe — those who share at least one workspace with the
   * subscriber, those who share a DM/private channel with them, plus the
   * subscriber themselves. Everyone else is dropped (not masked-offline — fully
   * excluded) so presence can't be used to enumerate strangers.
   */
  private async authorizePresenceTargets(
    state: SocketState,
    requested: string[],
  ): Promise<string[]> {
    const viewerId = state.user.userId;
    const allowed = new Set<string>();
    // Self is always observable (own real status).
    if (requested.includes(viewerId)) allowed.add(viewerId);
    const others = requested.filter((id) => id !== viewerId);
    if (others.length === 0) return [...allowed];

    // (1) Common-workspace members: any requested user who is a member of a
    // workspace the subscriber also belongs to. Single indexed query.
    if (state.workspaceIds.length > 0) {
      const shared = await this.prisma.workspaceMember.findMany({
        where: { userId: { in: others }, workspaceId: { in: state.workspaceIds } },
        select: { userId: true },
        distinct: ['userId'],
      });
      for (const m of shared) allowed.add(m.userId);
    }

    // (2) DM/private-channel peers: a user the subscriber shares a non-public
    // channel with (USER-principal ALLOW overrides — the same mechanism that
    // routes DM events in RoomManager). Only resolve the ids not already
    // admitted via a common workspace.
    const stillUnknown = others.filter((id) => !allowed.has(id));
    if (stillUnknown.length > 0) {
      const viewerChannels = await this.prisma.channelPermissionOverride.findMany({
        where: {
          principalType: 'USER',
          principalId: viewerId,
          allowMask: { gt: 0 },
          channel: { deletedAt: null },
        },
        select: { channelId: true },
      });
      const channelIds = viewerChannels.map((c) => c.channelId);
      if (channelIds.length > 0) {
        const peers = await this.prisma.channelPermissionOverride.findMany({
          where: {
            principalType: 'USER',
            principalId: { in: stillUnknown },
            allowMask: { gt: 0 },
            channelId: { in: channelIds },
          },
          select: { principalId: true },
          distinct: ['principalId'],
        });
        for (const p of peers) allowed.add(p.principalId);
      }
    }
    return [...allowed];
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

  private offlineGraceMs(): number {
    const sec = Number(process.env.PRESENCE_OFFLINE_GRACE ?? PRESENCE_OFFLINE_GRACE);
    return (Number.isFinite(sec) && sec > 0 ? sec : PRESENCE_OFFLINE_GRACE) * 1000;
  }

  private schedulePresenceBroadcast(workspaceId: string): void {
    this.throttler.schedule(workspaceId, async () => {
      const [online, dnd] = await Promise.all([
        this.presence.onlineIn(workspaceId),
        this.presence.dndIn(workspaceId),
      ]);
      // S25 (FR-RT-10): the idle subset of the online users. Computed ONCE per
      // flush off the already-resolved online list so observers can render the
      // idle dot (the throttler coalesces N schedule() calls into one flush).
      const idle = await this.presence.idleIn(online);
      // S25 fix-forward(contract HIGH): typed payload + WS_EVENTS constant. The
      // wire event name stays the dot form `presence.updated` — colon rename is
      // an S10 WS-naming carryover, this slice only types it.
      const payload: WorkspacePresenceUpdatedPayload = {
        workspaceId,
        onlineUserIds: online,
        // task-019-C: DnD subset so the client can render the dnd dot.
        dndUserIds: dnd,
        // S25 (FR-RT-10): IDLE subset (additive — old clients ignore it).
        idleUserIds: idle,
      };
      this.server
        .to(rooms.workspace(workspaceId))
        .emit(WS_EVENTS.WORKSPACE_PRESENCE_UPDATED, payload);
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
