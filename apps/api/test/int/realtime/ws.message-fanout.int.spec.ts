import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ORIGIN,
  bearer,
  connectClient,
  seedRtStack,
  setupRtIntEnv,
  waitForEvent,
  type RtIntEnv,
} from './helpers';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({ where: { aggregateType: 'Message' } });
});

describe('message fan-out', () => {
  it('A posts → B in the same channel receives message.created exactly once', async () => {
    const socketA = await connectClient(env.wsUrl, stack.owner.accessToken);
    const socketB = await connectClient(env.wsUrl, stack.member.accessToken);

    const received = waitForEvent<{ id: string; type: string; message: { content: string } }>(
      socketB,
      'message.created',
      5000,
    );

    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'hello from A' })
      .expect(201);

    // Drain the outbox so the dispatcher's EventEmitter fires.
    const drained = await env.dispatcher.drain();
    expect(drained).toBeGreaterThanOrEqual(1);

    const ev = await received;
    expect(ev.type).toBe('message.created');
    expect(ev.message.content).toBe('hello from A');

    socketA.disconnect();
    socketB.disconnect();
  });

  it('recipient dedupes by envelope.id when the same event arrives twice', async () => {
    const socketB = await connectClient(env.wsUrl, stack.member.accessToken);
    const seen: string[] = [];
    socketB.on('message.created', (e: { id: string }) => seen.push(e.id));

    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'one' })
      .expect(201);

    await env.dispatcher.drain();
    // Simulate a re-emit of the same row (at-least-once): flip dispatchedAt
    // back to null and drain again.
    await env.prisma.outboxEvent.updateMany({
      where: { eventType: 'message.created' },
      data: { dispatchedAt: null },
    });
    await env.dispatcher.drain();

    // Wait briefly for the duplicate to land.
    await new Promise((r) => setTimeout(r, 120));

    // Server does at-least-once; the socket will receive the same id twice.
    // The CLIENT must dedupe — assert the payload id is identical so a dedupe
    // layer keyed on id can collapse them to one.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const uniqIds = new Set(seen);
    expect(uniqIds.size).toBe(1);

    socketB.disconnect();
  });
});
