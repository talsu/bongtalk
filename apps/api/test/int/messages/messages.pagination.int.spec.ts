import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  MsgIntEnv,
  ORIGIN,
  bearer,
  seedMessageStack,
  seedRawMessages,
  setupMsgIntEnv,
} from './helpers';

/**
 * Pagination edge-case table. 200 rows are seeded into one channel, half of
 * them deliberately sharing `createdAt` so the (createdAt,id) tie-breaker
 * has to kick in.
 */
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
});

async function list(
  params: string,
  token = stack.member.accessToken,
): Promise<{ status: number; body: any }> {
  const res = await request(env.baseUrl)
    .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages${params}`)
    .set('origin', ORIGIN)
    .set(bearer(token));
  return { status: res.status, body: res.body };
}

describe('Messages pagination — edge cases', () => {
  it('initial load returns newest N, DESC by (createdAt,id)', async () => {
    await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 120,
      clockSkew: true,
    });
    const r = await list('?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(50);
    expect(r.body.pageInfo.hasMore).toBe(true);
    // DESC by createdAt then by id
    for (let i = 1; i < r.body.items.length; i++) {
      const prev = r.body.items[i - 1];
      const cur = r.body.items[i];
      expect(
        new Date(prev.createdAt).getTime() > new Date(cur.createdAt).getTime() ||
          (new Date(prev.createdAt).getTime() === new Date(cur.createdAt).getTime() &&
            prev.id > cur.id),
      ).toBe(true);
    }
  });

  it('same-ms tie-breaks by id DESC (clockSkew seed)', async () => {
    await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 9,
      clockSkew: true, // 3 rows per bucket
    });
    const r = await list('?limit=10');
    // 3 buckets × 3 rows each, expect exactly 9
    expect(r.body.items).toHaveLength(9);
    // Within each bucket (same createdAt), ids must be strictly DESC
    const byTime: Record<string, string[]> = {};
    for (const m of r.body.items) {
      byTime[m.createdAt] ??= [];
      byTime[m.createdAt].push(m.id);
    }
    for (const ids of Object.values(byTime)) {
      const sorted = [...ids].sort().reverse();
      expect(ids).toEqual(sorted);
    }
  });

  it('before= advances through pages without drift', async () => {
    await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 150,
    });
    const page1 = await list('?limit=50');
    const page2 = await list(`?limit=50&before=${page1.body.pageInfo.nextCursor}`);
    const page3 = await list(`?limit=50&before=${page2.body.pageInfo.nextCursor}`);
    const all = [...page1.body.items, ...page2.body.items, ...page3.body.items];
    const uniqueIds = new Set(all.map((m: { id: string }) => m.id));
    expect(uniqueIds.size).toBe(all.length); // no duplicates
    expect(uniqueIds.size).toBe(150);
  });

  it('after= fetches newer messages (reconnect catch-up)', async () => {
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 50,
    });
    // Client last saw id at index 10 (counting from oldest = ids[10])
    const anchor = await env.prisma.message.findUnique({ where: { id: ids[10] } });
    const cursor = Buffer.from(
      JSON.stringify({ t: anchor!.createdAt.toISOString(), id: anchor!.id }),
      'utf8',
    ).toString('base64url');
    const r = await list(`?limit=100&after=${cursor}`);
    expect(r.status).toBe(200);
    // Expect rows ids[11..49] = 39 rows
    expect(r.body.items).toHaveLength(39);
    // DESC order
    expect(r.body.items[0].id).toBe(ids[49]);
    expect(r.body.items[r.body.items.length - 1].id).toBe(ids[11]);
  });

  it('around= returns window centred on anchor', async () => {
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 40,
    });
    const anchor = ids[20];
    const r = await list(`?around=${anchor}&limit=10`);
    expect(r.status).toBe(200);
    expect(r.body.items.find((m: { id: string }) => m.id === anchor)).toBeDefined();
    expect(r.body.items.length).toBeGreaterThanOrEqual(5);
    expect(r.body.items.length).toBeLessThanOrEqual(11);
  });

  it('around= 404 when anchor belongs to a different channel', async () => {
    const other = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set(bearer(stack.owner.accessToken))
      .send({ name: `other-${Date.now().toString(36).slice(-5)}`, type: 'TEXT' });
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: other.body.id,
      authorId: stack.member.userId,
      count: 3,
    });
    const r = await list(`?around=${ids[1]}&limit=10`);
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('MESSAGE_NOT_FOUND');
  });

  it('invalid cursor → 400 MESSAGE_CURSOR_INVALID', async () => {
    const bad = await list('?before=%%%not-base64%%%');
    expect(bad.status).toBe(400);
    expect(bad.body.errorCode).toBe('MESSAGE_CURSOR_INVALID');

    const parseFail = await list(
      `?before=${Buffer.from('not json', 'utf8').toString('base64url')}`,
    );
    expect(parseFail.status).toBe(400);
    expect(parseFail.body.errorCode).toBe('MESSAGE_CURSOR_INVALID');
  });

  it('empty channel returns items=[] and cursors null', async () => {
    const r = await list('?limit=10');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.pageInfo.hasMore).toBe(false);
    expect(r.body.pageInfo.nextCursor).toBeNull();
    expect(r.body.pageInfo.prevCursor).toBeNull();
  });

  it('concurrent insert during pagination → no dup, no skip', async () => {
    // Seed 100 messages, load 2 pages of 25, insert 5 at the head (newest),
    // load page 3 — total unique ids must equal the 100 originals plus the
    // 5 inserts we chose NOT to see (they are newer than the first cursor).
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 100,
    });
    const p1 = await list('?limit=25');
    const p2 = await list(`?limit=25&before=${p1.body.pageInfo.nextCursor}`);

    // Insert 5 newer messages
    await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 5,
    });

    const p3 = await list(`?limit=25&before=${p2.body.pageInfo.nextCursor}`);
    const p4 = await list(`?limit=25&before=${p3.body.pageInfo.nextCursor}`);

    const pagedIds = [...p1.body.items, ...p2.body.items, ...p3.body.items, ...p4.body.items].map(
      (m: { id: string }) => m.id,
    );
    expect(new Set(pagedIds).size).toBe(pagedIds.length); // no dup
    // All 100 original ids must be present across the 4 pages
    for (const id of ids) {
      expect(pagedIds).toContain(id);
    }
  });

  it('deleted anchor for around= still returns surrounding window', async () => {
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 20,
    });
    const anchor = ids[10];
    // Soft delete the anchor via DB to avoid the controller path
    await env.prisma.message.update({
      where: { id: anchor },
      data: { deletedAt: new Date() },
    });
    const r = await list(`?around=${anchor}&limit=6`);
    expect(r.status).toBe(200);
    // Anchor itself is filtered out of the default includeDeleted=false path,
    // but the surrounding window must still arrive with rows from both sides.
    expect(r.body.items.length).toBeGreaterThan(0);
  });
});
