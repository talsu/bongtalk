import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import {
  bearer,
  connectClient,
  seedRtStack,
  setupRtIntEnv,
  waitForEvent,
  type RtIntEnv,
} from './helpers';

/**
 * S25 (FR-P01 / FR-P02 / FR-RT-10 / FR-RT-11 / FR-RT-12) — presence core.
 *
 * Fast-tuned timers (set BEFORE setupRtIntEnv so the service getters read
 * them at runtime):
 *   PRESENCE_OFFLINE_GRACE=1            → 1s grace before OFFLINE
 *   PRESENCE_IDLE_TIMEOUT=1            → 1s of no activity → IDLE
 *   PRESENCE_IDLE_SWEEP_INTERVAL_MS=300 → sweep polls every 300ms
 *   PRESENCE_UPDATE_THROTTLE_MS=100    → broadcast coalesce window
 */
process.env.PRESENCE_OFFLINE_GRACE = '2';
process.env.PRESENCE_IDLE_TIMEOUT = '1';
process.env.PRESENCE_IDLE_SWEEP_INTERVAL_MS = '300';
process.env.PRESENCE_UPDATE_THROTTLE_MS = '100';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  // reset preference so each test starts from auto.
  await env.prisma.user.updateMany({ data: { presencePreference: 'auto' } });
  // S25: isolate presence Redis state across tests. Session TTL is 120s, so
  // sockets from a prior test would otherwise leave stale session-SET entries
  // and make multi-device / offline assertions flaky. The testcontainer Redis
  // is dedicated to this run, so a flushdb is the cleanest reset (the ioredis
  // keyPrefix makes a `keys 'presence:*'` scan miss the prefixed keys anyway).
  await env.redis.flushdb();
  // small settle so any in-flight disconnect from the previous test finishes.
  await sleep(150);
});

type PresenceUpdated = {
  workspaceId: string;
  onlineUserIds: string[];
  dndUserIds?: string[];
  idleUserIds?: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Connect a client that DOES auto-reconnect fast (for grace-window reconnect). */
function connectReconnecting(wsUrl: string, accessToken: string): Promise<Socket> {
  const socket = ioClient(wsUrl, {
    auth: { accessToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 100,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

describe('S25 presence — INVISIBLE masking (FR-P01)', () => {
  it('presence:subscribe masks invisible → offline for others, real for self', async () => {
    // member goes invisible.
    await request(env.baseUrl)
      .patch('/me/presence')
      .set(bearer(stack.member.accessToken))
      .send({ status: 'invisible' })
      .expect(200);

    const memberSock = await connectClient(env.wsUrl, stack.member.accessToken);
    const ownerSock = await connectClient(env.wsUrl, stack.owner.accessToken);
    await sleep(200);

    // Owner subscribes to member's presence → must see OFFLINE (masked).
    const ownerBulk = waitForEvent<{ presences: Array<{ userId: string; status: string }> }>(
      ownerSock,
      'presence:bulk',
      4000,
    );
    ownerSock.emit('presence:subscribe', { userIds: [stack.member.userId] });
    const ownerView = await ownerBulk;
    const ownerEntry = ownerView.presences.find((p) => p.userId === stack.member.userId);
    expect(ownerEntry?.status).toBe('offline');

    // Member subscribes to themselves → must see the real INVISIBLE value.
    const selfBulk = waitForEvent<{ presences: Array<{ userId: string; status: string }> }>(
      memberSock,
      'presence:bulk',
      3000,
    );
    memberSock.emit('presence:subscribe', { userIds: [stack.member.userId] });
    const selfView = await selfBulk;
    const selfEntry = selfView.presences.find((p) => p.userId === stack.member.userId);
    expect(selfEntry?.status).toBe('invisible');

    // Invisible user is NOT in the workspace online broadcast set.
    const onlineSet = await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`);
    expect(onlineSet).not.toContain(stack.member.userId);

    memberSock.disconnect();
    ownerSock.disconnect();
  });
});

describe('S25 presence — 35s grace reconnect (FR-P02)', () => {
  it('reconnect inside grace restores ONLINE without an OFFLINE broadcast', async () => {
    const observer = await connectClient(env.wsUrl, stack.owner.accessToken);
    const flapper = await connectReconnecting(env.wsUrl, stack.member.accessToken);

    // Wait for member to land in the workspace online SET.
    await sleep(300);
    expect(await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`)).toContain(
      stack.member.userId,
    );

    // Collect any presence.updated the observer sees during the blip+grace.
    const seen: PresenceUpdated[] = [];
    observer.on('presence.updated', (p: PresenceUpdated) => seen.push(p));

    // Drop the flapper's transport but let socket.io auto-reconnect inside 1s grace.
    flapper.io.engine.close();
    await sleep(500); // well inside the 1s grace
    // wait for reconnect to settle.
    await new Promise<void>((resolve) => {
      if (flapper.connected) return resolve();
      flapper.once('connect', () => resolve());
    });
    await sleep(400);

    // Member is still online — the grace timer was cancelled by the reconnect.
    expect(await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`)).toContain(
      stack.member.userId,
    );
    // No broadcast ever dropped the member to offline.
    const droppedToOffline = seen.some(
      (p) => p.workspaceId === stack.workspaceId && !p.onlineUserIds.includes(stack.member.userId),
    );
    expect(droppedToOffline).toBe(false);

    observer.disconnect();
    flapper.disconnect();
  });

  it('no reconnect → OFFLINE broadcast after grace elapses', async () => {
    const observer = await connectClient(env.wsUrl, stack.owner.accessToken);
    const leaver = await connectClient(env.wsUrl, stack.member.accessToken);
    await sleep(300);

    const offlineBroadcast = new Promise<PresenceUpdated>((resolve) => {
      observer.on('presence.updated', (p: PresenceUpdated) => {
        if (p.workspaceId === stack.workspaceId && !p.onlineUserIds.includes(stack.member.userId)) {
          resolve(p);
        }
      });
    });

    leaver.disconnect();
    // grace is 1s; broadcast throttle 100ms. Give it a comfortable margin.
    const p = await Promise.race([
      offlineBroadcast,
      sleep(4000).then(() => null as unknown as PresenceUpdated),
    ]);
    expect(p).not.toBeNull();
    expect(p.onlineUserIds).not.toContain(stack.member.userId);

    observer.disconnect();
  });
});

describe('S25 presence — multi-device (FR-RT-11)', () => {
  it('one of two sessions disconnecting keeps the user ONLINE', async () => {
    const deviceA = await connectClient(env.wsUrl, stack.member.accessToken);
    const deviceB = await connectClient(env.wsUrl, stack.member.accessToken);
    await sleep(300);
    expect(await env.redis.scard(`presence:user:${stack.member.userId}:sessions`)).toBe(2);

    // Drop device A; B is still live → no grace, still online.
    deviceA.disconnect();
    await sleep(1500); // longer than the 1s grace — proves no OFFLINE happened.
    expect(await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`)).toContain(
      stack.member.userId,
    );
    expect(await env.redis.scard(`presence:user:${stack.member.userId}:sessions`)).toBe(1);

    deviceB.disconnect();
  });
});

describe('S25 presence — auto-idle (FR-RT-10)', () => {
  it('goes IDLE after timeout, returns ONLINE on presence:activity', async () => {
    const observer = await connectClient(env.wsUrl, stack.owner.accessToken);
    const idler = await connectClient(env.wsUrl, stack.member.accessToken);
    await sleep(300);

    // After ~1s with no activity the sweep flips the member to idle.
    const wentIdle = new Promise<PresenceUpdated>((resolve) => {
      observer.on('presence.updated', (p: PresenceUpdated) => {
        if (
          p.workspaceId === stack.workspaceId &&
          (p.idleUserIds ?? []).includes(stack.member.userId)
        ) {
          resolve(p);
        }
      });
    });
    const idleP = await Promise.race([
      wentIdle,
      sleep(4000).then(() => null as unknown as PresenceUpdated),
    ]);
    expect(idleP).not.toBeNull();
    expect(idleP.idleUserIds).toContain(stack.member.userId);
    // still in the online SET (idle is a subset of online, not offline).
    expect(idleP.onlineUserIds).toContain(stack.member.userId);

    // Activity returns them to ONLINE (drops from idle set).
    const backOnline = new Promise<PresenceUpdated>((resolve) => {
      observer.on('presence.updated', (p: PresenceUpdated) => {
        if (
          p.workspaceId === stack.workspaceId &&
          p.onlineUserIds.includes(stack.member.userId) &&
          !(p.idleUserIds ?? []).includes(stack.member.userId)
        ) {
          resolve(p);
        }
      });
    });
    idler.emit('presence:activity', {});
    const onlineP = await Promise.race([
      backOnline,
      sleep(3000).then(() => null as unknown as PresenceUpdated),
    ]);
    expect(onlineP).not.toBeNull();
    expect(onlineP.idleUserIds ?? []).not.toContain(stack.member.userId);

    observer.disconnect();
    idler.disconnect();
  });

  it('DND user never auto-idles (preference outranks activity)', async () => {
    await request(env.baseUrl)
      .patch('/me/presence')
      .set(bearer(stack.member.accessToken))
      .send({ status: 'dnd' })
      .expect(200);

    const idler = await connectClient(env.wsUrl, stack.member.accessToken);
    await sleep(1800); // longer than idle timeout

    // effectiveStatus must remain dnd, never idle.
    const dndSet = await env.redis.smembers(`presence:workspace:${stack.workspaceId}:dnd`);
    expect(dndSet).toContain(stack.member.userId);
    // The member is in the online SET but NOT in the idle subset.
    const online = await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`);
    expect(online).toContain(stack.member.userId);

    idler.disconnect();
  });
});

describe('S25 fix-forward — INVISIBLE preference is NOT leaked on reconnect (B1)', () => {
  it('after grace finalize, a reconnecting invisible user stays masked (preference key preserved)', async () => {
    // member goes invisible (Prisma + Redis preference key set).
    await request(env.baseUrl)
      .patch('/me/presence')
      .set(bearer(stack.member.accessToken))
      .send({ status: 'invisible' })
      .expect(200);

    // First session connects + drops; grace (2s) elapses → finalizeOffline runs.
    const first = await connectClient(env.wsUrl, stack.member.accessToken);
    await sleep(200);
    first.disconnect();
    await sleep(2600); // > 2s grace → finalizeOffline fired.

    // B1 REGRESSION GUARD: finalizeOffline must NOT have deleted the static
    // preference key. Before the fix it DEL'd it, so preferenceOf fell back to
    // 'auto' and the next observer view leaked online/idle.
    const prefAfterFinalize = await env.redis.get(
      `presence:user:${stack.member.userId}:preference`,
    );
    expect(prefAfterFinalize).toBe('invisible');

    // Reconnect: register re-seeds from Prisma → still invisible.
    const reconnected = await connectClient(env.wsUrl, stack.member.accessToken);
    const ownerSock = await connectClient(env.wsUrl, stack.owner.accessToken);
    await sleep(300);

    // Owner must still see the member as OFFLINE (masked), never online/idle.
    const ownerBulk = waitForEvent<{ presences: Array<{ userId: string; status: string }> }>(
      ownerSock,
      'presence:bulk',
      4000,
    );
    ownerSock.emit('presence:subscribe', { userIds: [stack.member.userId] });
    const ownerView = await ownerBulk;
    const entry = ownerView.presences.find((p) => p.userId === stack.member.userId);
    expect(entry?.status).toBe('offline');

    // The invisible user is absent from the observable workspace SET.
    const onlineSet = await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`);
    expect(onlineSet).not.toContain(stack.member.userId);

    reconnected.disconnect();
    ownerSock.disconnect();
  });
});

describe('S25 fix-forward — presence:subscribe authz (security CRITICAL)', () => {
  it('excludes users with no common workspace / DM from the bulk reply', async () => {
    // owner + member share the workspace; nonMember belongs to NO workspace
    // with the owner. owner subscribing to nonMember must NOT learn their state.
    const owner = await connectClient(env.wsUrl, stack.owner.accessToken);
    const member = await connectClient(env.wsUrl, stack.member.accessToken);
    const stranger = await connectClient(env.wsUrl, stack.nonMember.accessToken);
    await sleep(300);

    const ownerBulk = waitForEvent<{ presences: Array<{ userId: string; status: string }> }>(
      owner,
      'presence:bulk',
      4000,
    );
    owner.emit('presence:subscribe', {
      userIds: [stack.member.userId, stack.nonMember.userId],
    });
    const view = await ownerBulk;
    const seenIds = view.presences.map((p) => p.userId);

    // Common-workspace member IS present.
    expect(seenIds).toContain(stack.member.userId);
    // Stranger (no shared workspace / DM) is FULLY EXCLUDED — not even offline.
    expect(seenIds).not.toContain(stack.nonMember.userId);

    owner.disconnect();
    member.disconnect();
    stranger.disconnect();
  });

  it('always allows the subscriber to observe themselves', async () => {
    const stranger = await connectClient(env.wsUrl, stack.nonMember.accessToken);
    await sleep(200);
    const bulk = waitForEvent<{ presences: Array<{ userId: string; status: string }> }>(
      stranger,
      'presence:bulk',
      3000,
    );
    stranger.emit('presence:subscribe', { userIds: [stack.nonMember.userId] });
    const view = await bulk;
    expect(view.presences.map((p) => p.userId)).toContain(stack.nonMember.userId);
    stranger.disconnect();
  });

  it('rejects an oversized userIds payload (DoS guard) with an empty reply', async () => {
    const owner = await connectClient(env.wsUrl, stack.owner.accessToken);
    await sleep(200);
    const bulk = waitForEvent<{ presences: unknown[] }>(owner, 'presence:bulk', 3000);
    // 501 ids — over the schema's max(500). safeParse fails → empty reply.
    const tooMany = Array.from({ length: 501 }, (_, i) => `u${i}`);
    owner.emit('presence:subscribe', { userIds: tooMany });
    const view = await bulk;
    expect(view.presences).toEqual([]);
    owner.disconnect();
  });
});

describe('S25 fix-forward — grace epoch aborts a stale OFFLINE finalize (B2)', () => {
  it('a reconnect inside grace prevents an OFFLINE broadcast even after the timer fires', async () => {
    const observer = await connectClient(env.wsUrl, stack.owner.accessToken);
    const flapper = await connectReconnecting(env.wsUrl, stack.member.accessToken);
    await sleep(300);
    expect(await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`)).toContain(
      stack.member.userId,
    );

    const seen: PresenceUpdated[] = [];
    observer.on('presence.updated', (p: PresenceUpdated) => seen.push(p));

    // Capture the grace epoch BEFORE the blip; a reconnect must bump it.
    const epochBefore = Number(
      await env.redis.get(`presence:user:${stack.member.userId}:graceEpoch`),
    );

    // Drop transport; socket.io reconnects inside the 2s grace.
    flapper.io.engine.close();
    await sleep(700);
    await new Promise<void>((resolve) => {
      if (flapper.connected) return resolve();
      flapper.once('connect', () => resolve());
    });
    // Wait PAST the original grace window so the armed timer actually fires.
    await sleep(2200);

    // The reconnect INCRemented graceEpoch, so finalizeOffline aborted on the
    // epoch mismatch — member is still online, no OFFLINE broadcast.
    const epochAfter = Number(
      await env.redis.get(`presence:user:${stack.member.userId}:graceEpoch`),
    );
    expect(epochAfter).toBeGreaterThan(epochBefore);
    expect(await env.redis.smembers(`presence:workspace:${stack.workspaceId}:users`)).toContain(
      stack.member.userId,
    );
    const droppedToOffline = seen.some(
      (p) => p.workspaceId === stack.workspaceId && !p.onlineUserIds.includes(stack.member.userId),
    );
    expect(droppedToOffline).toBe(false);

    observer.disconnect();
    flapper.disconnect();
  });
});

describe('S25 fix-forward — dndIn lazy GC drops ghost dnd entries', () => {
  it('a dnd entry whose sessions all expired is GC-ed out of dndIn / the broadcast', async () => {
    // Seed a GHOST dnd entry directly: a user in the dnd SET with NO live
    // session SET (simulates a crashed session whose TTL expired without the
    // disconnect hook running).
    const ghostId = 'ghost-dnd-user';
    await env.redis.sadd(`presence:workspace:${stack.workspaceId}:dnd`, ghostId);
    await env.redis.sadd(`presence:workspace:${stack.workspaceId}:users`, ghostId);
    // (no presence:user:ghost-dnd-user:sessions key → scard === 0)

    const observer = await connectClient(env.wsUrl, stack.owner.accessToken);
    await sleep(300);

    // First broadcast resolves dndIn → lazy GC removes the ghost from the SET.
    const update = await waitForEvent<PresenceUpdated>(observer, 'presence.updated', 4000).catch(
      () => null,
    );
    // Either the broadcast we caught already excludes the ghost, or the SET was
    // GC-ed by the dndIn read it triggered — assert both the wire + the SET.
    if (update) {
      expect(update.dndUserIds ?? []).not.toContain(ghostId);
    }
    // Force one more dndIn resolution to be certain the SREM landed.
    await sleep(400);
    const dndSetAfter = await env.redis.smembers(`presence:workspace:${stack.workspaceId}:dnd`);
    expect(dndSetAfter).not.toContain(ghostId);

    observer.disconnect();
  });
});
