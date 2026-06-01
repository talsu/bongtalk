import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Redis from 'ioredis';
import { bearer, type ChIntEnv, ORIGIN, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';
import { UnreadService } from '../../../src/channels/unread.service';
import { REDIS } from '../../../src/redis/redis.module';

let env: ChIntEnv;
let unread: UnreadService;
let redis: Redis;

beforeAll(async () => {
  env = await setupChIntEnv();
  unread = env.app.get(UnreadService);
  redis = env.app.get<Redis>(REDIS);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(
  workspaceId: string,
  ownerToken: string,
  name: string,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(ownerToken))
    .send({ name, type: 'TEXT' });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function postMessage(
  workspaceId: string,
  channelId: string,
  token: string,
  content: string,
  mentions: { everyone?: boolean; here?: boolean; channel?: boolean } = {},
): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content, mentions });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
}

/**
 * S21 (FR-RS-14): Redis unread 캐시 + stampede 락 + (FR-RS-16) mentionCount.
 * ioredis 클라이언트가 keyPrefix `qufox:` 를 명령마다 자동 부착하므로, 같은
 * 클라이언트로 검증할 땐 미접두 키(`unread:{ws}:{user}`)를 그대로 쓴다.
 */
describe('S21 unread cache + stampede lock (FR-RS-14) + mentionCount (FR-RS-16)', () => {
  it('FR-RS-14: cachedWorkspaceTotal warms the Redis hash on a miss, then serves a hit', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'cache-warm');
    await postMessage(workspaceId, chId, owner.accessToken, 'c1');
    await postMessage(workspaceId, chId, owner.accessToken, 'c2');

    const cacheKey = `unread:${workspaceId}:${member.userId}`;
    // Cold: no cache.
    expect(await redis.exists(cacheKey)).toBe(0);

    const first = await unread.cachedWorkspaceTotal(workspaceId, member.userId);
    expect(first.unreadCount).toBe(2);
    expect(first.mentionCount).toBe(0);
    // Warmed: the per-channel hash now exists.
    expect(await redis.exists(cacheKey)).toBe(1);
    const stored = await redis.hget(cacheKey, chId);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string).unreadCount).toBe(2);

    // Stale-but-cached hit: mutate the DB underneath WITHOUT invalidating, the
    // cached read must still return the warmed value (proves it served cache).
    await postMessage(workspaceId, chId, owner.accessToken, 'c3-uncounted');
    const second = await unread.cachedWorkspaceTotal(workspaceId, member.userId);
    expect(second.unreadCount).toBe(2); // cache hit, not the fresh 3
  });

  it('FR-RS-14: ack invalidates the cache so the next cached read re-aggregates', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'cache-inval');
    await postMessage(workspaceId, chId, owner.accessToken, 'i1');
    await postMessage(workspaceId, chId, owner.accessToken, 'i2');

    // Warm the cache (unread = 2).
    const warmed = await unread.cachedWorkspaceTotal(workspaceId, member.userId);
    expect(warmed.unreadCount).toBe(2);

    // Find the latest message id to ack.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${chId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const latestId = (list.body.items as Array<{ id: string }>)[0].id;

    const ack = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${chId}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: latestId });
    expect(ack.status).toBe(200);

    // ACK deleted the cache key.
    const cacheKey = `unread:${workspaceId}:${member.userId}`;
    expect(await redis.exists(cacheKey)).toBe(0);

    // Next cached read re-aggregates from the DB → 0 unread.
    const after = await unread.cachedWorkspaceTotal(workspaceId, member.userId);
    expect(after.unreadCount).toBe(0);
  });

  it('FR-RS-14: a held stampede lock prevents the concurrent miss from caching', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'stampede');
    await postMessage(workspaceId, chId, owner.accessToken, 's1');

    const lockKey = `unread:lock:${workspaceId}:${member.userId}`;
    const cacheKey = `unread:${workspaceId}:${member.userId}`;
    // Pre-seize the lock as a competing aggregator would.
    await redis.set(lockKey, '1', 'PX', 5000, 'NX');

    // The caller can't win the lock → still returns the correct DB count, but
    // does NOT write the cache (no stampede write while another holder works).
    const total = await unread.cachedWorkspaceTotal(workspaceId, member.userId);
    expect(total.unreadCount).toBe(1);
    expect(await redis.exists(cacheKey)).toBe(0); // not warmed by the loser

    await redis.del(lockKey);
    // With the lock free, the next miss warms the cache.
    const warmed = await unread.cachedWorkspaceTotal(workspaceId, member.userId);
    expect(warmed.unreadCount).toBe(1);
    expect(await redis.exists(cacheKey)).toBe(1);
  });

  it('FR-RS-16: mentionCount counts unread mention messages and resets to 0 on ack', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'mentions');
    // OWNER posts an @everyone (kept) + an @channel (kept) + a plain message.
    await postMessage(workspaceId, chId, owner.accessToken, 'all hands', { everyone: true });
    await postMessage(workspaceId, chId, owner.accessToken, 'this channel', { channel: true });
    await postMessage(workspaceId, chId, owner.accessToken, 'just chatting');

    const summary = await unread.summarize(workspaceId, member.userId);
    const row = summary.find((c) => c.channelId === chId);
    expect(row).toBeDefined();
    expect(row?.unreadCount).toBe(3);
    expect(row?.mentionCount).toBe(2); // @everyone + @channel
    expect(row?.hasMention).toBe(true);

    // Ack to the latest message → mentionCount resets to 0.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${chId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const latestId = (list.body.items as Array<{ id: string }>)[0].id;
    const ack = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${chId}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: latestId });
    expect(ack.status).toBe(200);
    expect(ack.body.unreadCount).toBe(0);
    expect(ack.body.mentionCount).toBe(0);
  });

  it('FR-RS-16: a MEMBER @everyone is gated → does NOT count as a mention', async () => {
    const { workspaceId, owner, admin, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'gated');
    // MEMBER posts an @everyone — gate.ts downgrades it to false on store.
    await postMessage(workspaceId, chId, member.accessToken, 'hey all', { everyone: true });

    // admin (OWNER/ADMIN-class reader) sees the message as unread but NOT a mention.
    const summary = await unread.summarize(workspaceId, admin.userId);
    const row = summary.find((c) => c.channelId === chId);
    expect(row?.unreadCount).toBe(1);
    expect(row?.mentionCount).toBe(0);
    expect(row?.hasMention).toBe(false);
  });
});
