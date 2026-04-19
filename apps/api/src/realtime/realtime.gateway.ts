import { Logger } from '@nestjs/common';
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
import { ReplayBufferService } from './projection/replay-buffer.service';
import { rooms } from './rooms/room-names';

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
    private readonly prisma: PrismaService,
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
      client.disconnect(true);
      return;
    }
    const {
      rooms: joinable,
      workspaceIds,
      channelIds,
    } = await this.roomMgr.roomsForUser(user.userId);
    await client.join(joinable);
    client.data.state = { user, workspaceIds, channelIds } satisfies SocketState;

    await this.presence.register({
      sessionId: user.sessionId,
      userId: user.userId,
      workspaceIds,
    });

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

  async handleDisconnect(client: Socket): Promise<void> {
    const state = client.data.state as SocketState | undefined;
    if (!state) return;
    const { goneFrom } = await this.presence.unregister({
      sessionId: state.user.sessionId,
      userId: state.user.userId,
      workspaceIds: state.workspaceIds,
    });
    for (const wsId of goneFrom) {
      this.schedulePresenceBroadcast(wsId);
    }
    this.logger.log(
      `[ws] -disconnect user=${state.user.userId} sid=${state.user.sessionId} goneFromWs=${goneFrom.length}`,
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
      const online = await this.presence.onlineIn(workspaceId);
      this.server.to(rooms.workspace(workspaceId)).emit('presence.updated', {
        workspaceId,
        onlineUserIds: online,
      });
    });
  }
}

function pickLastEventId(client: Socket): string | null {
  const header = client.handshake.headers['x-last-event-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = client.handshake.auth as { lastEventId?: string } | undefined;
  if (auth?.lastEventId && typeof auth.lastEventId === 'string') return auth.lastEventId;
  return null;
}
