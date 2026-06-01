import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  collectEvents,
  connectReady,
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
 *   S26 (FR-P07): 10 s TTL auto-clears if the client vanishes without a
 *   stop signal (was 5 s; unified on the shared TYPING_TTL constant).
 * - Disconnect hook proactively drops the user from every channel
 *   they were in and re-broadcasts.
 */
describe('typing gateway (task-018-F)', () => {
  it('A pings → B receives typing.updated with A in the set', async () => {
    const a = await connectReady(env.wsUrl, stack.owner.accessToken);
    const b = await connectReady(env.wsUrl, stack.member.accessToken);

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
    const a = await connectReady(env.wsUrl, stack.owner.accessToken);
    const b = await connectReady(env.wsUrl, stack.member.accessToken);

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

  it('Redis SET has the userId with a finite TTL after a ping (S26: 10s)', async () => {
    const a = await connectReady(env.wsUrl, stack.owner.accessToken);
    a.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 200));

    const members = await env.redis.smembers(`typing:channel:${stack.channelId}`);
    expect(members).toContain(stack.owner.userId);
    const ttl = await env.redis.ttl(`typing:channel:${stack.channelId}`);
    expect(ttl).toBeGreaterThan(0);
    // S26 (FR-P07): TTL is now 10s (TYPING_TTL), not 5s.
    expect(ttl).toBeLessThanOrEqual(10);
    expect(ttl).toBeGreaterThan(5);

    a.disconnect();
  });

  it('disconnect clears the user from typing SET and fan-outs update', async () => {
    const a = await connectReady(env.wsUrl, stack.owner.accessToken);
    const b = await connectReady(env.wsUrl, stack.member.accessToken);

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
    const nm = await connectReady(env.wsUrl, stack.nonMember.accessToken);
    const b = await connectReady(env.wsUrl, stack.member.accessToken);

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

/**
 * S26 (FR-DM-14): DM channels reuse the SAME typing path as ordinary channels
 * — there is no `dm:typing_*` prefix. A DIRECT channel is admitted into the
 * socket's channelIds via its USER-level ALLOW override (RoomManager), so
 * typing.ping passes the membership check and broadcasts typing.updated into
 * the channel room exactly like a TEXT channel. This proves DM typing works
 * end-to-end on the unified path.
 */
describe('S26 typing — DM channel uses the unified path (FR-DM-14)', () => {
  let dmChannelId: string;

  beforeEach(async () => {
    // Create a 1:1 DIRECT channel between owner + member with USER ALLOW
    // overrides so both sockets eager-join its channel room on connect.
    const dm = await env.prisma.channel.create({
      data: {
        workspaceId: stack.workspaceId,
        name: `dm-typing-${Date.now().toString(36)}`,
        type: 'DIRECT',
        position: 9000,
        isPrivate: true,
      },
    });
    dmChannelId = dm.id;
    for (const uid of [stack.owner.userId, stack.member.userId]) {
      await env.prisma.channelPermissionOverride.create({
        data: {
          channelId: dm.id,
          principalType: 'USER',
          principalId: uid,
          allowMask: 1,
          denyMask: 0,
        },
      });
    }
  });

  it('A pings in a DM channel → B receives typing.updated (no dm: prefix)', async () => {
    const a = await connectReady(env.wsUrl, stack.owner.accessToken);
    const b = await connectReady(env.wsUrl, stack.member.accessToken);

    const received = waitForEvent<{ channelId: string; typingUserIds: string[] }>(
      b,
      'typing.updated',
      3000,
    );

    a.emit('typing.ping', { channelId: dmChannelId });

    const ev = await received;
    expect(ev.channelId).toBe(dmChannelId);
    expect(ev.typingUserIds).toContain(stack.owner.userId);

    // The DM typing SET lives under the SAME key namespace as ordinary
    // channels — no separate dm: prefix.
    const members = await env.redis.smembers(`typing:channel:${dmChannelId}`);
    expect(members).toContain(stack.owner.userId);

    a.disconnect();
    b.disconnect();
  });
});

/**
 * S26 (FR-P07): the typing broadcast names at most TYPING_MAX_VISIBLE (3) users
 * even when more are typing. The SET may hold more (TTL-GCed), but the wire
 * payload is capped so a busy channel never ships an unbounded id list — the
 * client renders "외 N명".
 */
describe('S26 typing — max-3 visible cap (FR-P07)', () => {
  it('caps typing.updated at 3 ids when 4 users type', async () => {
    // Reuse the suite-wide stack — owner / admin / member are all members of
    // its workspace + public TEXT channel, so all three eager-join the channel
    // room on connect. (A second seedRtStack in the same fork raced its slug
    // against the top-level one — WORKSPACE_SLUG_TAKEN.)
    //
    // We need 4 typers in the channel SET: the 3 real members + a pre-seeded
    // 4th id, so the broadcast set has 4 candidates and the next real ping
    // recomputes + caps it to 3 on the wire. beforeEach flushes typing:* so
    // the SET starts clean.
    const observer = await connectReady(env.wsUrl, stack.owner.accessToken);
    const t1 = await connectReady(env.wsUrl, stack.member.accessToken);
    const t2 = await connectReady(env.wsUrl, stack.admin.accessToken);

    // Pre-seed a 4th typer directly into the channel SET so the broadcast set
    // has 4 candidates; the next real ping recomputes + caps to 3.
    await env.redis.sadd(`typing:channel:${stack.channelId}`, 'phantom-typer-id');

    const updates = collectEvents<{ channelId: string; typingUserIds: string[] }>(
      observer,
      'typing.updated',
      1500,
    );

    // Three real pings; each recomputes the capped set.
    t1.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 50));
    t2.emit('typing.ping', { channelId: stack.channelId });
    await new Promise((r) => setTimeout(r, 50));
    observer.emit('typing.ping', { channelId: stack.channelId });

    const events = await updates;
    expect(events.length).toBeGreaterThan(0);
    // Every broadcast carried at most 3 ids (the cap), never 4.
    for (const ev of events) {
      expect(ev.typingUserIds.length).toBeLessThanOrEqual(3);
    }
    // The SET itself still holds all 4 (cap is wire-only, not a SET mutation).
    const setMembers = await env.redis.smembers(`typing:channel:${stack.channelId}`);
    expect(setMembers.length).toBeGreaterThanOrEqual(4);

    observer.disconnect();
    t1.disconnect();
    t2.disconnect();
  });
});
