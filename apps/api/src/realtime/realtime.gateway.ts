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
  PRESENCE_SUBSCRIBE_BURST_MAX,
  PRESENCE_SUBSCRIBE_BURST_WINDOW_MS,
  PresenceSubscribePayloadSchema,
  PresenceUnsubscribePayloadSchema,
  PresenceActivityPayloadSchema,
  TypingStartPayloadSchema,
  TypingStopPayloadSchema,
  maskPresenceForViewer,
  type ChannelJoinedPayload,
  type PresenceBulkPayload,
  type PresenceUpdatePayload,
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
import { TypingFanout } from './typing/typing-fanout';
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

  // S26 (FR-RT-12): per-socket presence:subscribe burst limiter. Channel-switch
  // bursts resend the subscribe list; we keep a sliding window of recent
  // timestamps per socketId and drop a subscribe once it exceeds
  // PRESENCE_SUBSCRIBE_BURST_MAX in the window. Cleared on disconnect so the map
  // can't grow unbounded. In-memory (node-local) is fine: a burst is inherently
  // a single-socket phenomenon and the socket lives on exactly one node.
  private readonly subscribeBurst = new Map<string, number[]>();

  // S32 (FR-RT-08): node-local typing fanout 정책 엔진(batch 타이머 + 채널
  // fanout rate-limit). afterInit 에서 server 가 준비된 뒤 1회 생성합니다.
  // 멀티노드 batch 조정은 단일 NAS 환경에서 무해(carryover).
  private typingFanout: TypingFanout | null = null;

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
    // S32 (FR-RT-08): typing fanout 엔진을 server 준비 후 1회 생성. emit 콜백은
    // 콜론 이벤트명(WS_EVENTS.TYPING_UPDATE/BATCH)으로 채널 룸에 브로드캐스트하고,
    // batch tick 의 최신 snapshot 조회는 TypingService.currentlyTyping 을 재사용.
    this.typingFanout = new TypingFanout({
      emitBatch: (channelId, userIds) => {
        // S32 fix-forward(contract CRITICAL): 와이어 필드명을 `typingUserIds` 로
        // 통일(typing:update 와 동일 키). 종전 `userIds` 키는 dispatcher 가 더는
        // 읽지 않습니다.
        this.server.to(rooms.channel(channelId)).emit(WS_EVENTS.TYPING_BATCH, {
          channelId,
          typingUserIds: userIds,
        });
        this.metrics?.wsEventsEmittedTotal
          .labels(this.metrics.bucket('wsEventType', WS_EVENTS.TYPING_BATCH))
          .inc();
      },
      emitUpdate: (channelId, userIds) => {
        this.server.to(rooms.channel(channelId)).emit(WS_EVENTS.TYPING_UPDATE, {
          channelId,
          typingUserIds: userIds,
        });
        this.metrics?.wsEventsEmittedTotal
          .labels(this.metrics.bucket('wsEventType', WS_EVENTS.TYPING_UPDATE))
          .inc();
      },
      currentTypers: (channelId) => this.typing.currentlyTyping(channelId),
    });
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
    // S32 (FR-RT-08): node-local batch 타이머를 모두 해제(프로세스 종료/HMR leak 방지).
    this.typingFanout?.dispose();
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

    // S32 (FR-RT-08): dot-form typing alias for the rollout window. The colon
    // events (typing:start / typing:stop) are the canonical @SubscribeMessage
    // handlers; @SubscribeMessage uses Reflect.defineMetadata which a SECOND
    // stacked decorator would overwrite (only one wins), so we register the
    // legacy dot names as socket-level listeners that forward to the same
    // handlers. Old deployed clients emitting `typing.ping` / `typing.stop`
    // keep working until the rollout completes. Removed in the S10 WS-naming
    // bundle once no dot-form clients remain.
    client.on('typing.ping', (body: unknown) => {
      void this.onTypingPing(client, body);
    });
    client.on('typing.stop', (body: unknown) => {
      void this.onTypingStop(client, body);
    });

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

    // S26 fix-forward(reviewer MAJOR-1 · cross-user leak): DEL any forward
    // subscription index left over for THIS socketId (engine.io sids are
    // reused, so a stale 5m-TTL set could belong to a DIFFERENT user from a
    // previous connection and would otherwise resurrect that user's
    // subscriptions for the new owner). A reconnect is a fresh sid and the
    // client resends presence:subscribe, so addSubscriptions rebuilds the index
    // — retaining the old socketId-keyed set was never observable and only
    // risked a leak. clearSubscriptions also SREMs the socket out of every
    // reverse index it lingered in.
    await this.presence.clearSubscriptions(client.id);

    await this.presence.register({
      sessionId: user.sessionId,
      userId: user.userId,
      workspaceIds,
      preference,
    });
    this.metrics?.wsPresenceSessionsActive.inc();

    // S69 (FR-W20): connection:ready 에 가입한 **모든** 워크스페이스의 멘션 카운트를
    // 싣는다(활성/비활성 무관). 비활성 워크스페이스의 서버아이콘 멘션 배지를 첫 페인트부터
    // 그릴 수 있게 한다. 기존 unread-totals read-through 캐시(cachedWorkspaceTotal)를
    // 재사용하므로 캐시 히트 시 DB 를 치지 않는다. 집계 실패는 비-치명(클라가 GET
    // /me/unread-totals 폴백으로 채움) — best-effort.
    let allWorkspaceMentionCounts: Array<{ workspaceId: string; mentionCount: number }> | undefined;
    try {
      allWorkspaceMentionCounts = await Promise.all(
        workspaceIds.map(async (wsId) => {
          const total = await this.unread.cachedWorkspaceTotal(wsId, user.userId);
          return { workspaceId: wsId, mentionCount: total.mentionCount };
        }),
      );
    } catch (err) {
      this.logger.warn(
        `[ws] connection:ready mention counts failed user=${user.userId}: ${String(err).slice(0, 160)}`,
      );
      allWorkspaceMentionCounts = undefined;
    }

    // FR-RT-01: signal the client that rooms are joined + presence is
    // registered. Emitted before any replay so the client can flip its
    // connection state to "ready" prior to catch-up events landing.
    client.emit(WS_EVENTS.CONNECTION_READY, {
      userId: user.userId,
      sessionId: user.sessionId,
      allWorkspaceMentionCounts,
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

    // S26 (FR-P16): this user just came ONLINE — push the precise status to any
    // socket already subscribed to them (e.g. a DM peer who subscribed while
    // this user was offline). Coarse workspace broadcasts above cover member
    // lists; this covers direct subscribers with no shared workspace room.
    await this.fanOutPresenceUpdate(user.userId);

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
        // S27 (FR-P10): the user actually went OFFLINE (grace elapsed without a
        // reconnect) → stamp lastSeenAt = now. goneFrom empty means a reconnect
        // aborted the finalize, so we DON'T touch lastSeenAt. INVISIBLE never
        // reaches here as a "went dark" stamp: an invisible user has no live
        // session to lose differently, but the leak guard is in the member list
        // (offline rows only) + the fact this stamp reflects a genuine OFFLINE.
        if (goneFrom.length > 0) {
          await this.prisma.user
            .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
            .catch(() => undefined);
        }
        for (const wsId of goneFrom) this.schedulePresenceBroadcast(wsId);
        // S26 (FR-P16): the user actually went OFFLINE — push the precise
        // status to their direct subscribers (e.g. a DM peer with no shared
        // workspace room). goneFrom empty means a reconnect aborted the
        // finalize, so no fan-out either.
        if (goneFrom.length > 0) await this.fanOutPresenceUpdate(userId);
      });
    }
    // task-018-F / S32 (FR-RT-08): also clear the user from any typing ZSETs so
    // the indicator drops before the TTL. The fanout engine reflects the new
    // count into its batch-timer state (a disconnect can drop a channel below
    // the batch threshold → timer clear + immediate typing:update), and emits
    // the refreshed snapshot via the colon events (typing:update / typing:batch).
    const clearedTypingChannels = await this.typing.dropForUser(
      state.user.userId,
      state.channelIds,
    );
    for (const chId of clearedTypingChannels) {
      const typingUserIds = await this.typing.currentlyTyping(chId);
      this.typingFanout?.onTypersChanged(chId, typingUserIds);
    }
    // S26 (FR-P16): don't DELETE this socket's subscription index on
    // disconnect — set a 5m TTL so a reconnect inside the window can resume
    // fan-out. Also drop the in-memory burst window for the dead socket so the
    // map can't leak.
    await this.presence.expireSubscriptions(client.id);
    this.subscribeBurst.delete(client.id);
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
    // IDLE → ONLINE: re-broadcast so workspace observers drop the idle dot.
    for (const wsId of state.workspaceIds) {
      this.schedulePresenceBroadcast(wsId);
    }
    // S26 (FR-P16): also push the precise new status to this user's direct
    // subscribers (DM peers / viewport watchers) who aren't necessarily in a
    // shared workspace room.
    await this.fanOutPresenceUpdate(state.user.userId);
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
    // S26 (FR-RT-12): channel-switch burst guard. Once a socket exceeds
    // PRESENCE_SUBSCRIBE_BURST_MAX subscribes inside the window we drop the
    // frame entirely (no bulk reply) — a flood is almost always a rapid
    // channel-switch resend storm, and the previous reply is still fresh.
    if (this.isSubscribeBursting(client.id)) {
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', 'presence:subscribe:dropped'))
        .inc();
      return;
    }
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
    // S26 (FR-RT-12 / FR-P16): persist the subscription so later state changes
    // for these users fan out to this socket (presence:update). Only the
    // authorized ids are stored — an unauthorized id can never become a
    // fan-out target.
    await this.presence.addSubscriptions(client.id, allowed);
    const bulk = await this.presence.bulkFor(state.user.userId, allowed);
    // S27 fix-forward(security): bulkFor now also returns the UNMASKED `real`
    // status + `masked` flag for the member-list lastSeenAt leak guard. Those
    // MUST NOT cross the WS wire — project down to the masked PresenceEntry
    // shape (userId/status/updatedAt) so the unmasked status never leaks to a
    // subscriber.
    const payload: PresenceBulkPayload = {
      presences: bulk.map(({ userId, status, updatedAt }) => ({ userId, status, updatedAt })),
    };
    client.emit(WS_EVENTS.PRESENCE_BULK, payload);
  }

  /**
   * S26 (FR-P16): presence:unsubscribe — drop the given userIds from this
   * socket's subscription set so they stop fanning out. Silent (no reply);
   * a malformed / oversized payload is ignored.
   */
  @SubscribeMessage(WS_EVENTS.PRESENCE_UNSUBSCRIBE)
  async onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    const parsed = PresenceUnsubscribePayloadSchema.safeParse(body);
    if (!parsed.success) return;
    const ids = [...new Set(parsed.data.userIds)];
    if (ids.length === 0) return;
    await this.presence.removeSubscriptions(client.id, ids);
  }

  /**
   * S26 (FR-RT-12): sliding-window burst check for presence:subscribe. Records
   * `now` and returns true if the socket has already issued
   * PRESENCE_SUBSCRIBE_BURST_MAX subscribes within the trailing window.
   */
  private isSubscribeBursting(socketId: string): boolean {
    const now = Date.now();
    const windowMs = burstWindowMs();
    const max = burstMax();
    const recent = (this.subscribeBurst.get(socketId) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.subscribeBurst.set(socketId, recent);
    return recent.length > max;
  }

  /**
   * S26 (FR-P16): fan out a single user's CURRENT effective status to every
   * socket currently subscribed to them (the reverse index), masked per the
   * subscriber. Routed by socketId via the Socket.IO adapter so it reaches
   * subscribers on other nodes too. This is the precise, per-subscriber
   * complement to the coarse workspace-room `presence.updated` broadcast:
   *   - presence.updated  → bulk online/dnd/idle sets to a whole workspace room
   *     (member-list dots; everyone in the workspace, no per-target opt-in)
   *   - presence:update   → one user's status to the specific sockets that
   *     asked for it (DM peers, viewport-limited member watchers), even with no
   *     shared workspace room
   */
  private async fanOutPresenceUpdate(userId: string): Promise<void> {
    if (!this.server) return;
    const subscriberSockets = await this.presence.subscribersOf(userId);
    if (subscriberSockets.length === 0) return;
    const real = await this.presence.effectiveStatus(userId);
    const updatedAt = new Date().toISOString();
    // Mask per subscriber: only the subscriber viewing THEMSELVES sees a real
    // invisible value. bulkFor centralizes the same masking, but here we have a
    // single target user and per-socket viewers, so we resolve the viewer from
    // each socket's own user id.
    const sockets = await this.server.in(subscriberSockets).fetchSockets();
    // S26 fix-forward(reviewer BLOCKER · authz-staleness teardown): a
    // subscription captured the viewer↔target authz at subscribe time. If the
    // viewer has since lost the right to observe `userId` — left/was kicked from
    // the last shared workspace, left a group DM (S19), or got blocked — that
    // subscription is now stale and must NOT fan out (online/offline transitions
    // would leak even though INVISIBLE is masked). We re-verify authz at fan-out
    // time against the live DB (the source of truth for every revocation vector
    // at once) rather than wiring a teardown hook into each vector's outbox
    // path (member_removed / dm.participant_removed and especially friend.blocked
    // — which today emits no outbox event and is intentionally invisible to the
    // blocked side, so there is no event to hang a hook on). Re-verification is
    // cached per viewer for this single fan-out (one DB check per distinct
    // viewer, not per socket), and a viewer who fails is self-healed out of the
    // reverse index so it isn't re-checked next time.
    const allowedByViewer = new Map<string, boolean>();
    const revoke: Array<{ socketId: string; viewerId: string }> = [];
    for (const s of sockets) {
      const data = (s as unknown as { data: { state?: SocketState } }).data;
      const viewerId = data.state?.user.userId;
      if (!viewerId) continue;
      let allowed = allowedByViewer.get(viewerId);
      if (allowed === undefined) {
        // Self always observes self; otherwise the viewer must still share a
        // workspace / DM with the target and not be in a block relation.
        allowed =
          viewerId === userId ||
          (await this.canStillObservePresence(data.state as SocketState, userId));
        allowedByViewer.set(viewerId, allowed);
      }
      if (!allowed) {
        revoke.push({ socketId: s.id, viewerId });
        continue;
      }
      const masked = maskPresenceForViewer(real, viewerId === userId);
      const payload: PresenceUpdatePayload = { userId, status: masked, updatedAt };
      s.emit(WS_EVENTS.PRESENCE_UPDATE, payload);
      this.metrics?.wsEventsEmittedTotal
        .labels(this.metrics.bucket('wsEventType', WS_EVENTS.PRESENCE_UPDATE))
        .inc();
    }
    // Self-heal: drop the now-unauthorized subscriptions so the stale viewer
    // stops being a fan-out candidate (no leak on subsequent transitions).
    for (const r of revoke) {
      await this.presence.removeSubscriptions(r.socketId, [userId]);
    }
  }

  /**
   * S26 fix-forward(reviewer BLOCKER · authz-staleness): does `viewer` STILL have
   * the right to observe `targetUserId`'s presence right now? Unlike the
   * subscribe-time authz, this must NOT trust the socket's cached
   * `state.workspaceIds` — a viewer who was kicked/left keeps the stale id in
   * memory until reconnect (refreshUserChannelIds only adds, never removes), and
   * authorizePresenceTargets only checks that the TARGET is in those workspaces,
   * not the viewer. So we re-read the VIEWER's current workspace membership from
   * the DB, intersect it against the target's, and additionally require a shared
   * DM/private channel as the second admit path. A BLOCKED friendship in EITHER
   * direction denies regardless. Any miss → false → the subscription is torn
   * down, so a stale online/offline transition can never leak.
   */
  private async canStillObservePresence(
    viewerState: SocketState,
    targetUserId: string,
  ): Promise<boolean> {
    const viewerId = viewerState.user.userId;
    // BLOCKED rows collapse to one row owned by the blocker (either direction),
    // so a single OR query covers both "viewer blocked target" and "target
    // blocked viewer". Presence must not leak across a block in either case.
    const blocked = await this.prisma.friendship.findFirst({
      where: {
        status: 'BLOCKED',
        OR: [
          { requesterId: viewerId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: viewerId },
        ],
      },
      select: { id: true },
    });
    if (blocked !== null) return false;

    // (1) Live shared-workspace check: both viewer AND target must currently be
    // members of the same non-deleted workspace. Re-read the viewer's live
    // memberships rather than trusting state.workspaceIds (which may be stale
    // after a kick/leave). A single query asks: is the target a member of any
    // workspace the viewer is still in?
    const viewerWs = await this.prisma.workspaceMember.findMany({
      where: { userId: viewerId, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    const viewerWsIds = viewerWs.map((m) => m.workspaceId);
    if (viewerWsIds.length > 0) {
      const shared = await this.prisma.workspaceMember.findFirst({
        where: { userId: targetUserId, workspaceId: { in: viewerWsIds } },
        select: { userId: true },
      });
      if (shared !== null) return true;
    }

    // (2) Live shared DM / private-channel check: a USER-principal ALLOW on a
    // non-deleted channel held by BOTH viewer and target (same mechanism that
    // routes DM events). Leaving a group DM revokes the override, so a stale
    // subscription falls through to false here.
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
    if (channelIds.length === 0) return false;
    const peer = await this.prisma.channelPermissionOverride.findFirst({
      where: {
        principalType: 'USER',
        principalId: targetUserId,
        allowMask: { gt: 0 },
        channelId: { in: channelIds },
      },
      select: { principalId: true },
    });
    return peer !== null;
  }

  /**
   * S26: public wrapper so non-WS paths (PATCH /me/presence controller) can
   * push a precise presence:update to a user's direct subscribers immediately,
   * alongside the existing workspace broadcast.
   */
  async fanOutPresenceUpdatePublic(userId: string): Promise<void> {
    await this.fanOutPresenceUpdate(userId);
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

  /**
   * S32 (FR-RT-08): typing start (= ping). Inbound 정본은 콜론(`typing:start`,
   * WS_EVENTS.TYPING_START)입니다. 점 표기 `typing.ping` 은 handleConnection 의
   * 소켓 레벨 리스너가 이 핸들러로 forward 합니다(롤아웃 호환). outbound 는 항상
   * 콜론(typing:update / typing:batch) — TypingFanout 이 batch 임계·rate-limit·
   * 이벤트명 수렴을 단일 지점에서 처리합니다.
   */
  @SubscribeMessage(WS_EVENTS.TYPING_START)
  async onTypingPing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    // S32 (security #5): presence:subscribe 패턴과 일치하게 형식 불량 페이로드를
    // 조기 거부합니다(타입힌트만으로는 런타임 보증이 없었음). ChannelIdSchema
    // 자체는 변경하지 않으며(광범위 영향), 멤버십 includes 가 권한을 계속 보호합니다.
    const parsed = TypingStartPayloadSchema.safeParse(body);
    if (!parsed.success) return;
    const { channelId } = parsed.data;
    if (!state.channelIds.includes(channelId)) return; // not a channel member
    const typingUserIds = await this.typing.ping(state.user.userId, channelId);
    if (!typingUserIds) return; // throttled — a recent broadcast already named us
    this.typingFanout?.onTypersChanged(channelId, typingUserIds);
  }

  /**
   * task-021-R1-typing-stale-on-clear / S32 (FR-RT-08): typing stop. 클라가
   * draft 를 비우거나 메시지 전송/채널 전환/10초 idle 시 전송합니다. 사용자를
   * ZSET 에서 제거 + 스로틀 키를 비워 다음 입력이 침묵당하지 않게 합니다.
   * inbound 정본은 콜론(`typing:stop`); 점 표기 `typing.stop` 은 handleConnection
   * 의 소켓 레벨 리스너가 forward 합니다(롤아웃 호환). outbound 는 TypingFanout 이
   * 콜론 이벤트로 fanout.
   */
  @SubscribeMessage(WS_EVENTS.TYPING_STOP)
  async onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    // S32 (security #5): 형식 불량 페이로드 조기 거부(presence 패턴 일치).
    const parsed = TypingStopPayloadSchema.safeParse(body);
    if (!parsed.success) return;
    const { channelId } = parsed.data;
    if (!state.channelIds.includes(channelId)) return;
    const res = await this.typing.stop(state.user.userId, channelId);
    if (!res.changed) return;
    // 인원수 변화를 fanout 에 반영(batch 모드 이탈/단건 전환/clear 결정).
    this.typingFanout?.onTypersChanged(channelId, res.members);
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
   *
   * S47 fix-forward (BLOCKER-2 · FR-MN-20): emit 시점에 서버 시계 `serverTimestamp`
   * 를 부착한다. 클라 badgeStore 가 이 시각을 lastAckedAt 으로 저장해, 같은 서버
   * 시계로 찍힌 notification:badge_update.serverTimestamp 와 동일 시계 비교를 하도록
   * 한다(종전 클라 Date.now() 기반 교차시계 비교가 서버 지연 시 정당한 신규
   * badge_update 를 stale 로 폐기하던 버그 제거). UnreadService 의 payload 생성부는
   * 그대로 두고 단일 emit 지점에서만 부착한다(모든 ACK 경로 일괄 적용).
   */
  emitReadStateUpdated(userId: string, payload: ReadStateUpdatedPayload): void {
    if (!this.server) return;
    const withTs: ReadStateUpdatedPayload = {
      ...payload,
      serverTimestamp: new Date().toISOString(),
    };
    this.server.to(rooms.user(userId)).emit(WS_EVENTS.READ_STATE_UPDATED, withTs);
    this.metrics?.wsEventsEmittedTotal
      .labels(this.metrics.bucket('wsEventType', WS_EVENTS.READ_STATE_UPDATED))
      .inc();
  }

  /**
   * S53 (D10 · FR-PS-09/10/11): emit an arbitrary user-scoped event to a
   * user's private room (user:{userId}). Used by the BullMQ ReminderProcessor
   * to push user:reminder_fire / user:saved_updated, and by the saved PATCH/
   * snooze paths to push user:saved_updated. Routed via the Socket.IO adapter
   * so it reaches the user's sockets on any node. If the gateway server isn't
   * ready yet or the user has no live socket, this is a harmless no-op (the
   * authoritative state lives in the DB; reconnect surfaces missed reminders
   * via the overdueReminder query).
   */
  emitToUserRoom(userId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(rooms.user(userId)).emit(event, payload);
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

/** S26 (FR-RT-12): presence:subscribe burst window (ms), env-overridable. */
function burstWindowMs(): number {
  const raw = Number(
    process.env.PRESENCE_SUBSCRIBE_BURST_WINDOW_MS ?? PRESENCE_SUBSCRIBE_BURST_WINDOW_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : PRESENCE_SUBSCRIBE_BURST_WINDOW_MS;
}

/** S26 (FR-RT-12): max presence:subscribe per burst window, env-overridable. */
function burstMax(): number {
  const raw = Number(process.env.PRESENCE_SUBSCRIBE_BURST_MAX ?? PRESENCE_SUBSCRIBE_BURST_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PRESENCE_SUBSCRIBE_BURST_MAX;
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
