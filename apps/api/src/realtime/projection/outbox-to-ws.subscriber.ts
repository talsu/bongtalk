import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Server } from 'socket.io';
import { RealtimeGateway } from '../realtime.gateway';
import { rooms } from '../rooms/room-names';
import { ReplayBufferService } from './replay-buffer.service';
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
  }

  @OnEvent('channel.**')
  async onChannelEvent(env: WsEnvelope): Promise<void> {
    // channel.created is new to the receiver — they might not be in the
    // channel room yet — so route via the workspace room instead.
    const wsId = env.workspaceId;
    if (!wsId) return;
    if (env.type === 'channel.created' || env.type === 'channel.deleted') {
      await this.emitAndBuffer('workspace', wsId, env);
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

  private async emitAndBuffer(
    scope: 'channel' | 'workspace',
    id: string,
    env: WsEnvelope,
  ): Promise<void> {
    if (!this.io) return;
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
    this.metrics?.wsEventsEmittedTotal.labels(env.type).inc();
    // Fan-out latency = occurredAt → now (emit). The per-channel replay
    // append + socket.io emit both happen in this frame, so `now` captures
    // the wire handoff moment.
    const fanoutSec = (Date.now() - new Date(env.occurredAt).getTime()) / 1000;
    if (Number.isFinite(fanoutSec) && fanoutSec >= 0) {
      this.metrics?.wsMessageFanoutLatencySeconds.observe(fanoutSec);
    }
  }
}
