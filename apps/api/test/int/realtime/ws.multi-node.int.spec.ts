import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  bearer,
  connectClient,
  seedRtStack,
  setupRtIntEnv,
  waitForEvent,
  type RtIntEnv,
} from './helpers';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;
let secondary: Awaited<ReturnType<RtIntEnv['spawnSecondInstance']>>;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
  secondary = await env.spawnSecondInstance();
}, 300_000);

afterAll(async () => {
  await secondary?.stop();
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.redis.del(`replay:channel:${stack.channelId}`);
});

describe('multi-node fan-out via Redis adapter', () => {
  it('A connects to node-1, B to node-2 — A sends → B receives', async () => {
    const socketA = await connectClient(env.wsUrl, stack.owner.accessToken);
    const socketB = await connectClient(secondary.wsUrl, stack.member.accessToken);

    const received = waitForEvent<{ id: string; type: string; message: { content: string } }>(
      socketB,
      'message.created',
      5000,
    );

    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'cross-node hi' })
      .expect(201);

    await env.dispatcher.drain();

    const ev = await received;
    expect(ev.message.content).toBe('cross-node hi');

    socketA.disconnect();
    socketB.disconnect();
  });
});
