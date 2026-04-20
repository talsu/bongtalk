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
import { PrismaService } from '../prisma/prisma.module';
import { WsAuthMiddleware, WsUserPayload } from './handshake/ws-auth.middleware';
import { RoomManagerService } from './rooms/room-manager.service';
import { PresenceService } from './presence/presence.service';
import { PresenceThrottler } from './presence/presence-throttler';
import { TypingService } from './typing/typing.service';
import { ReplayBufferService } from './projection/replay-buffer.service';
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
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
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
      let truncated = false;
      for (const chId of channelIds) {
        const res = await this.replay.rangeAfter('channel', chId, lastEventId);
        if (res.truncated) {
          truncated = true;
          continue;
        }
        for (const ev of res.events) {
          client.emit(ev.type, ev.payload);
          replayed++;
        }
      }
      if (truncated) client.emit('replay.truncated', { lastEventId });
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

  @SubscribeMessage('channel:read')
  async onRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId?: string; eventId?: string },
  ): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state || !body?.channelId || !body?.eventId) return;
    if (!state.channelIds.includes(body.channelId)) return;
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
