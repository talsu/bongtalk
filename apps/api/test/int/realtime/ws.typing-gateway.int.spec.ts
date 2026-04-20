import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectClient, seedRtStack, setupRtIntEnv, waitForEvent, type RtIntEnv } from './helpers';

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
  // Clear any leftover typing / throttle keys from prior assertions.
  const ks = await env.redis.keys('typing:*');
  if (ks.length > 0) await env.redis.del(...ks);
});

/**
 * Task-018-F: typing indicator gateway contract.
 *
 * - Client emits `typing.ping { channelId }`; server broadcasts
 *   `typing.updated { channelId, typingUserIds }` to every socket in
 *   the channel room.
 * - Per-user-per-channel throttle: consecutive pings inside
 *   TYPING_THROTTLE_SEC (default 3 s) drop silently.
 * - Redis SET `typing:channel:<channelId>` holds the typing members;
 *   5 s TTL auto-clears if the client vanishes without a stop signal.
 * - Disconnect hook proactively drops the user from every channel
 *   they were in and re-broadcasts.
 */
describe('typing gateway (task-018-F)', () => {
  it('A pings → B receives typing.updated with A in the set', async () => {
    const a = await connectClient(env.wsUrl, stack.owner.accessToken);
    const b = await connectClient(env.wsUrl, stack.member.accessToken);

    const received = waitForEvent<{ channelId: string; typingUserIds: string[] }>(
      b,
      'typing.updated',
      3000,
    );

    a.emit('typing.ping', { channelId: stack.channelId });

    const ev = await received;
    expect(ev.channelId).toBe(stack.channelId);
    expect(ev.typingUserIds).toContain(stack.owner.userId);

    a.disconnect();
    b.disconnect();
  });

  it('throttles consecutive pings from the same user within the window', async () => {
    const a = await connectClient(env.wsUrl, stack.owner.accessToken);
    const b = await connectClient(env.wsUrl, stack.member.accessToken);

    const count = { n: 0 };
    b.on('typing.updated', () => {
      count.n += 1;
    });

    a.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 200));
    a.emit('typing.ping', { channelId: stack.channelId });
    a.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 400));

    expect(count.n).toBe(1);

    a.disconnect();
    b.disconnect();
  });

  it('Redis SET has the userId with a finite TTL after a ping', async () => {
    const a = await connectClient(env.wsUrl, stack.owner.accessToken);
    a.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 200));

    const members = await env.redis.smembers(`typing:channel:${stack.channelId}`);
    expect(members).toContain(stack.owner.userId);
    const ttl = await env.redis.ttl(`typing:channel:${stack.channelId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);

    a.disconnect();
  });

  it('disconnect clears the user from typing SET and fan-outs update', async () => {
    const a = await connectClient(env.wsUrl, stack.owner.accessToken);
    const b = await connectClient(env.wsUrl, stack.member.accessToken);

    // Seed A into the typing set.
    a.emit('typing.ping', { channelId: stack.channelId });
    await waitForEvent(b, 'typing.updated', 2000);

    const afterDisconnect = waitForEvent<{ typingUserIds: string[] }>(b, 'typing.updated', 3000);

    a.disconnect();

    const ev = await afterDisconnect;
    expect(ev.typingUserIds).not.toContain(stack.owner.userId);

    b.disconnect();
  });

  it('ignores pings for channels the caller is not a member of', async () => {
    const nm = await connectClient(env.wsUrl, stack.nonMember.accessToken);
    const b = await connectClient(env.wsUrl, stack.member.accessToken);

    let received = false;
    b.on('typing.updated', () => {
      received = true;
    });

    nm.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 500));

    expect(received).toBe(false);
    const members = await env.redis.smembers(`typing:channel:${stack.channelId}`);
    expect(members).not.toContain(stack.nonMember.userId);

    nm.disconnect();
    b.disconnect();
  });
});
