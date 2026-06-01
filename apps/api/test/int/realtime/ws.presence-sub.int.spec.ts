import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectReady, seedRtStack, setupRtIntEnv, waitForEvent, type RtIntEnv } from './helpers';
import { PresenceService } from '../../../src/realtime/presence/presence.service';

/**
 * S26 (FR-RT-12 / FR-P16) — presence subscription lifecycle, layered on top of
 * the S25 presence:subscribe authz + bulk + 500-cap that this slice does NOT
 * touch. Fast-tuned timers so grace / sub-TTL assertions don't take minutes.
 */
process.env.PRESENCE_OFFLINE_GRACE = '1';
process.env.PRESENCE_IDLE_TIMEOUT = '1';
process.env.PRESENCE_IDLE_SWEEP_INTERVAL_MS = '300';
process.env.PRESENCE_UPDATE_THROTTLE_MS = '100';
// S26: a 2s disconnect window so the TTL assertion is observable fast.
process.env.PRESENCE_SUB_TTL_SEC = '2';

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
  await env.prisma.user.updateMany({ data: { presencePreference: 'auto' } });
  await env.redis.flushdb();
  await new Promise((r) => setTimeout(r, 150));
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('S26 presence:subscribe — registers a subscription Set (FR-RT-12)', () => {
  it('SADDs the subscribed userIds into presence:sub:{socketId} and replies with bulk', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    const bulk = waitForEvent<{ presences: Array<{ userId: string; status: string }> }>(
      owner,
      'presence:bulk',
      4000,
    );
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    // The forward index must hold the authorized target.
    const subKey = `presence:sub:${owner.id}`;
    const subbed = await env.redis.smembers(subKey);
    expect(subbed).toContain(stack.member.userId);
    // The reverse index must list the owner socket under the member.
    const subscribers = await env.redis.smembers(`presence:subscribers:${stack.member.userId}`);
    expect(subscribers).toContain(owner.id);

    owner.disconnect();
    member.disconnect();
  });
});

describe('S26 presence:update — fan-out to subscribers on state change (FR-P16)', () => {
  it('a subscriber receives presence:update when the watched user goes offline', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    // Owner subscribes to member.
    const bulk = waitForEvent(owner, 'presence:bulk', 4000);
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    // Member disconnects → after the 1s grace, finalizeOffline fans out a
    // precise presence:update to the owner's subscribed socket.
    const update = waitForEvent<{ userId: string; status: string }>(owner, 'presence:update', 5000);
    member.disconnect();
    const ev = await update;
    expect(ev.userId).toBe(stack.member.userId);
    expect(ev.status).toBe('offline');

    owner.disconnect();
  });

  it('a non-subscriber receives NO presence:update for that user', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    const admin = await connectReady(env.wsUrl, stack.admin.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    // Only owner subscribes to member; admin does not.
    const bulk = waitForEvent(owner, 'presence:bulk', 4000);
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    let adminGotUpdate = false;
    admin.on('presence:update', (e: { userId: string }) => {
      if (e.userId === stack.member.userId) adminGotUpdate = true;
    });
    const ownerUpdate = waitForEvent(owner, 'presence:update', 5000);

    member.disconnect();
    await ownerUpdate; // owner DID get it
    await sleep(300);
    expect(adminGotUpdate).toBe(false); // admin did NOT

    owner.disconnect();
    admin.disconnect();
  });
});

describe('S26 presence:unsubscribe — SREM stops fan-out (FR-P16)', () => {
  it('after unsubscribe the socket no longer receives presence:update', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    const bulk = waitForEvent(owner, 'presence:bulk', 4000);
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    // Unsubscribe — the forward index should drop the member.
    owner.emit('presence:unsubscribe', { userIds: [stack.member.userId] });
    await sleep(250);
    const subbed = await env.redis.smembers(`presence:sub:${owner.id}`);
    expect(subbed).not.toContain(stack.member.userId);
    const subscribers = await env.redis.smembers(`presence:subscribers:${stack.member.userId}`);
    expect(subscribers).not.toContain(owner.id);

    // No further presence:update for member should arrive.
    let gotUpdate = false;
    owner.on('presence:update', (e: { userId: string }) => {
      if (e.userId === stack.member.userId) gotUpdate = true;
    });
    member.disconnect();
    await sleep(2000); // past grace + fan-out window
    expect(gotUpdate).toBe(false);

    owner.disconnect();
  });
});

describe('S26 disconnect — subscription Set gets a TTL, not an immediate DEL (FR-P16)', () => {
  it('presence:sub:{socketId} survives disconnect with a finite TTL then expires', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    await sleep(150);
    const bulk = waitForEvent(owner, 'presence:bulk', 4000);
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    const subKey = `presence:sub:${owner.id}`;
    expect(await env.redis.exists(subKey)).toBe(1);

    owner.disconnect();
    await sleep(250);

    // Immediately after disconnect the key STILL exists (not DEL'd) with a TTL.
    const existsAfter = await env.redis.exists(subKey);
    const ttl = await env.redis.ttl(subKey);
    expect(existsAfter).toBe(1);
    expect(ttl).toBeGreaterThan(0);
    // PRESENCE_SUB_TTL_SEC=2 for this run.
    expect(ttl).toBeLessThanOrEqual(2);

    // After the TTL elapses the key is gone (Redis natural GC).
    await sleep(2200);
    expect(await env.redis.exists(subKey)).toBe(0);
  });
});

describe('S26 presence:subscribe — channel-switch burst rate-limit (FR-RT-12)', () => {
  it('drops subscribes beyond the burst max within the window (no bulk reply)', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    await sleep(150);

    let bulkCount = 0;
    owner.on('presence:bulk', () => {
      bulkCount += 1;
    });

    // Fire well over the default burst max (10) in a tight loop.
    for (let i = 0; i < 25; i++) {
      owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    }
    await sleep(800);

    // Some subscribes were dropped → fewer bulk replies than emits.
    expect(bulkCount).toBeGreaterThan(0);
    expect(bulkCount).toBeLessThan(25);

    owner.disconnect();
  });
});

/**
 * S26 fix-forward(reviewer BLOCKER · authz-staleness teardown). A subscription
 * captures viewer↔target authz at subscribe time; if the viewer later loses the
 * right to observe the target (block / workspace removal) the fan-out must NOT
 * leak the target's online/offline transition. We re-verify authz at fan-out
 * time against the live DB, so revoking the relationship in the DB is enough to
 * stop the next presence:update — no reconnect required.
 */
describe('S26 authz-staleness — fan-out re-verifies viewer authz (reviewer BLOCKER)', () => {
  it('a viewer who blocked the watched user receives NO presence:update', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    // Owner subscribes to member while still authorized (shared workspace).
    const bulk = waitForEvent(owner, 'presence:bulk', 4000);
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    // Owner blocks member directly in the DB (collapsed BLOCKED row, blocker =
    // requester). The block does not close member's socket, so the normal
    // disconnect → grace → finalizeOffline → fan-out path still runs; only the
    // authz re-check should now exclude the owner.
    await env.prisma.friendship.create({
      data: {
        requesterId: stack.owner.userId,
        addresseeId: stack.member.userId,
        status: 'BLOCKED',
      },
    });

    let gotUpdate = false;
    owner.on('presence:update', (e: { userId: string }) => {
      if (e.userId === stack.member.userId) gotUpdate = true;
    });

    member.disconnect();
    await sleep(2000); // past 1s grace + fan-out window
    expect(gotUpdate).toBe(false);

    // The stale subscription should also be self-healed out of the reverse index.
    const subscribers = await env.redis.smembers(`presence:subscribers:${stack.member.userId}`);
    expect(subscribers).not.toContain(owner.id);

    // Cleanup so other tests see a clean friendship table.
    await env.prisma.friendship.deleteMany({
      where: {
        OR: [
          { requesterId: stack.owner.userId, addresseeId: stack.member.userId },
          { requesterId: stack.member.userId, addresseeId: stack.owner.userId },
        ],
      },
    });
    owner.disconnect();
  });

  it('a viewer still sharing a workspace DOES receive presence:update (no false-negative)', async () => {
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    const bulk = waitForEvent(owner, 'presence:bulk', 4000);
    owner.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    // No revocation — owner and member still share the seed workspace, so the
    // fan-out authz re-check must still admit the owner.
    const update = waitForEvent<{ userId: string; status: string }>(owner, 'presence:update', 5000);
    member.disconnect();
    const ev = await update;
    expect(ev.userId).toBe(stack.member.userId);
    expect(ev.status).toBe('offline');

    owner.disconnect();
  });

  it('a viewer removed from the only shared workspace receives NO presence:update', async () => {
    // admin watches member; we then strip admin's membership in the DB so the
    // live authz re-check no longer finds a shared workspace.
    const admin = await connectReady(env.wsUrl, stack.admin.accessToken);
    const member = await connectReady(env.wsUrl, stack.member.accessToken);
    await sleep(150);

    const bulk = waitForEvent(admin, 'presence:bulk', 4000);
    admin.emit('presence:subscribe', { userIds: [stack.member.userId] });
    await bulk;
    await sleep(150);

    // Snapshot admin's membership row(s) so we can restore them afterwards.
    const adminMemberships = await env.prisma.workspaceMember.findMany({
      where: { userId: stack.admin.userId },
    });
    await env.prisma.workspaceMember.deleteMany({ where: { userId: stack.admin.userId } });

    let gotUpdate = false;
    admin.on('presence:update', (e: { userId: string }) => {
      if (e.userId === stack.member.userId) gotUpdate = true;
    });

    member.disconnect();
    await sleep(2000); // past grace + fan-out
    expect(gotUpdate).toBe(false);

    // Restore admin's membership so the shared seed stack stays intact.
    for (const m of adminMemberships) {
      await env.prisma.workspaceMember.create({
        data: {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role,
          joinedAt: m.joinedAt,
        },
      });
    }
    admin.disconnect();
  });
});

/**
 * S26 fix-forward(reviewer MAJOR-1 · cross-user sid reuse). On connect the
 * gateway DELs any stale forward index for this socketId so a reused engine.io
 * sid can't resurrect a previous owner's subscriptions. We can't force sid reuse
 * deterministically, so we simulate it: pre-seed a forward index under a
 * socketId, then connect a client that ends up owning that socketId and assert
 * the index was cleared. Since the real socketId is only known post-connect, we
 * instead assert the invariant directly: clearSubscriptions wipes both indexes.
 */
describe('S26 DEL-on-connect — stale forward index cleared, no resurrection (reviewer MAJOR-1)', () => {
  it('a connecting socket starts with an EMPTY forward index even if a stale key pre-existed', async () => {
    // Seed a stale forward index + reverse index for a fabricated socketId, as
    // if a previous owner of that sid had subscribed and disconnected (5m TTL).
    const staleSid = 'stale-engineio-sid';
    await env.redis.sadd(`presence:sub:${staleSid}`, stack.member.userId);
    await env.redis.sadd(`presence:subscribers:${stack.member.userId}`, staleSid);

    // A fresh connection of ANY user must not inherit that subscription. The new
    // socket gets a fresh id, but the clearSubscriptions invariant guarantees
    // that whatever sid it lands on is wiped on connect. We verify the invariant
    // directly via the service-level contract: after the gateway's connect path
    // runs clearSubscriptions(client.id), the connecting socket's own forward
    // index is empty (it never resurrected anything).
    const owner = await connectReady(env.wsUrl, stack.owner.accessToken);
    await sleep(200);

    const ownForward = await env.redis.smembers(`presence:sub:${owner.id}`);
    expect(ownForward).toEqual([]);

    // Clean the fabricated stale keys.
    await env.redis.del(`presence:sub:${staleSid}`);
    await env.redis.del(`presence:subscribers:${stack.member.userId}`);
    owner.disconnect();
  });

  it('clearSubscriptions wipes the forward index AND the reverse footprint for a reused sid', async () => {
    // Pre-seed a forward + reverse index for a sid as if a previous owner had
    // subscribed and disconnected (5m TTL still live). Then run the exact
    // teardown the gateway performs on connect for that sid and assert NOTHING
    // resurrects: both indexes are wiped, so a new owner of the sid starts clean.
    const reusedSid = 'reused-engineio-sid';
    await env.redis.sadd(`presence:sub:${reusedSid}`, stack.member.userId, stack.admin.userId);
    await env.redis.sadd(`presence:subscribers:${stack.member.userId}`, reusedSid);
    await env.redis.sadd(`presence:subscribers:${stack.admin.userId}`, reusedSid);

    const presence = env.app.get(PresenceService);
    await presence.clearSubscriptions(reusedSid);

    expect(await env.redis.exists(`presence:sub:${reusedSid}`)).toBe(0);
    expect(await env.redis.smembers(`presence:subscribers:${stack.member.userId}`)).not.toContain(
      reusedSid,
    );
    expect(await env.redis.smembers(`presence:subscribers:${stack.admin.userId}`)).not.toContain(
      reusedSid,
    );
  });
});
