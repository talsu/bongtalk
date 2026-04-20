import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RealtimeGateway } from '../realtime.gateway';
import { rooms } from '../rooms/room-names';
import type { WsEnvelope } from '../events/ws-event-envelope';

/**
 * Workspace-level revocation. Per-user kicks for `workspace.member.{left,removed}`
 * are handled inline inside `OutboxToWsSubscriber.onWorkspaceEvent` to avoid
 * EventEmitter2 handler-order surprises in wildcard mode — having two
 * handlers both call `kickUserEverywhere` caused a double-kick race.
 */
@Injectable()
export class MembershipRevocationListener {
  constructor(private readonly gateway: RealtimeGateway) {}

  @OnEvent('workspace.deleted')
  async onWorkspaceDeleted(env: WsEnvelope): Promise<void> {
    if (!env.workspaceId) return;
    const room = rooms.workspace(env.workspaceId);
    const sockets = await this.gateway.server.in(room).fetchSockets();
    for (const s of sockets) s.emit('connection.error', { code: 'workspace_deleted' });
    this.gateway.server.in(room).disconnectSockets(true);
  }
}
