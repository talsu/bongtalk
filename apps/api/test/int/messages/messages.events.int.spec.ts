import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({ where: { aggregateType: 'Message' } });
});

describe('Messages outbox events', () => {
  it('POST records message.created with the agreed envelope shape', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'hello outbox' });
    expect(post.status).toBe(201);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message' },
    });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.eventType).toBe('message.created');
    expect(e.aggregateId).toBe(post.body.message.id);
    expect(e.dispatchedAt).toBeNull();
    const payload = e.payload as unknown as {
      workspaceId: string;
      channelId: string;
      actorId: string;
      message: { id: string; content: string };
    };
    expect(payload.workspaceId).toBe(stack.workspaceId);
    expect(payload.channelId).toBe(stack.channelId);
    expect(payload.actorId).toBe(stack.member.userId);
    expect(payload.message.content).toBe('hello outbox');
  });

  it('dispatcher drain emits an envelope with id + type + occurredAt', async () => {
    const received: Array<{ id: string; type: string }> = [];
    const ee = env.app.get(EventEmitter2);
    const handler = (e: { id: string; type: string }) => received.push({ id: e.id, type: e.type });
    ee.on('message.created', handler);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'drain me' });
    expect(post.status).toBe(201);

    await env.dispatcher.drain();
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('message.created');
    const dispatched = await env.prisma.outboxEvent.findFirst({
      where: { aggregateType: 'Message' },
    });
    expect(dispatched?.dispatchedAt).not.toBeNull();
    expect(received[0].id).toBe(dispatched?.id);
    ee.off('message.created', handler);
  });

  it('PATCH edit records message.updated; DELETE records message.deleted', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'orig' });
    const msgId = post.body.message.id;

    await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'edited' })
      .expect(200);
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message', aggregateId: msgId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'message.created',
      'message.updated',
      'message.deleted',
    ]);
  });

  it('tx rollback → no outbox row (send fails due to archived channel)', async () => {
    // Archive the channel so POST fails inside the guard before tx runs
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/archive`)
      .set(bearer(stack.owner.accessToken))
      .expect(201);
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'blocked' });
    expect(post.status).toBe(409);
    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message' },
    });
    expect(events).toHaveLength(0);
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/unarchive`)
      .set(bearer(stack.owner.accessToken));
  });
});
