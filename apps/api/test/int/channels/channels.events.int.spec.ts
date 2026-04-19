/**
 * Asserts that every channel state-change writes an OutboxEvent row and that
 * the dispatcher fans it out via EventEmitter2 on the next drain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChIntEnv,
  ORIGIN,
  bearer,
  seedWorkspaceWithRoles,
  setupChIntEnv,
} from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;
let emitter: EventEmitter2;

beforeAll(async () => {
  env = await setupChIntEnv();
  seed = await seedWorkspaceWithRoles(env.baseUrl);
  emitter = env.app.get(EventEmitter2);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('Channel outbox events', () => {
  it('CHANNEL_CREATED is recorded and dispatched', async () => {
    const received: unknown[] = [];
    const handler = (e: unknown) => received.push(e);
    emitter.on('channel.created', handler);

    const { workspaceId, admin } = seed;
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ name: `ev-${Date.now().toString(36)}`, type: 'TEXT' });
    expect(res.status).toBe(201);

    // Row exists, not yet dispatched
    const before = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'channel.created', aggregateId: res.body.id },
    });
    expect(before).toBeTruthy();
    expect(before!.dispatchedAt).toBeNull();

    // Drain → handler fires, dispatchedAt set
    const n = await env.dispatcher.drain();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(received.some((e) => (e as { actorId?: string }).actorId)).toBe(true);

    const after = await env.prisma.outboxEvent.findUnique({ where: { id: before!.id } });
    expect(after!.dispatchedAt).not.toBeNull();

    emitter.off('channel.created', handler);
  });
});
