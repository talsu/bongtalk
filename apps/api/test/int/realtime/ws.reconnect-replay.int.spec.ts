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

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  // Also clear the replay stream for this channel.
  await env.redis.del(`replay:channel:${stack.channelId}`);
});

describe('reconnect replay', () => {
  it('replays events after lastEventId, no gaps or duplicates', async () => {
    // 1. Post 10 messages while member is disconnected.
    const eventIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set(bearer(stack.owner.accessToken))
        .send({ content: `pre #${i}` })
        .expect(201);
    }
    await env.dispatcher.drain();
    const events = await env.prisma.outboxEvent.findMany({
      orderBy: { occurredAt: 'asc' },
    });
    for (const e of events) eventIds.push(e.id);
    expect(eventIds).toHaveLength(10);

    // 2. Reconnect with lastEventId = id of the 5th event → expect 5 replay.
    const anchor = eventIds[4];
    const socket = await connectClient(env.wsUrl, stack.member.accessToken, {
      lastEventId: anchor,
    });
    const replayedIds: string[] = [];
    socket.on('message.created', (e: { id: string }) => replayedIds.push(e.id));
    const complete = await waitForEvent<{ replayed: number }>(socket, 'replay.complete', 5000);
    expect(complete.replayed).toBe(5);

    // The 5 replayed ids should be exactly eventIds[5..9] in order.
    expect(replayedIds).toEqual(eventIds.slice(5));

    socket.disconnect();
  });

  it('emits replay.truncated when lastEventId rolled off the window', async () => {
    // Set stream cap small via env and forcibly exceed it.
    const origCap = process.env.WS_REPLAY_BUFFER_SIZE;
    process.env.WS_REPLAY_BUFFER_SIZE = '5';
    try {
      for (let i = 0; i < 8; i++) {
        await request(env.baseUrl)
          .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
          .set(bearer(stack.owner.accessToken))
          .send({ content: `m${i}` })
          .expect(201);
      }
      await env.dispatcher.drain();

      // lastEventId that is NOT in the stream (bogus uuid).
      const socket = await connectClient(env.wsUrl, stack.member.accessToken, {
        lastEventId: '00000000-0000-4000-8000-000000000001',
      });
      const t = await waitForEvent<{ lastEventId: string }>(socket, 'replay.truncated', 5000);
      expect(t.lastEventId).toBe('00000000-0000-4000-8000-000000000001');
      socket.disconnect();
    } finally {
      if (origCap) process.env.WS_REPLAY_BUFFER_SIZE = origCap;
      else delete process.env.WS_REPLAY_BUFFER_SIZE;
    }
  });
});
