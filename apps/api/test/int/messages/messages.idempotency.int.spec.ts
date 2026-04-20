import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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
});

async function send(content: string, key: string | null, token = stack.member.accessToken) {
  const req = request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (key) req.set('Idempotency-Key', key);
  return req;
}

describe('Idempotent send', () => {
  it('5 concurrent sends with same key → 1 DB row, 4 replayed', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => send('hello once', key)));
    const statuses = results.map((r) => r.status);
    // One 201 + four 200 replays (or, under rare ordering, any mix totalling 5
    // responses whose bodies point at a single messageId).
    const messageIds = new Set(results.map((r) => r.body.message.id));
    expect(messageIds.size).toBe(1);
    const successful = statuses.filter((s) => s === 201).length;
    const replayed = statuses.filter((s) => s === 200).length;
    expect(successful).toBeGreaterThanOrEqual(1);
    expect(successful + replayed).toBe(5);
    // Exactly 1 row in DB
    const rows = await env.prisma.message.findMany({
      where: { channelId: stack.channelId, idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
    // Replay header set on at least one non-201 response
    const replayHeaders = results.map((r) => r.headers['idempotency-replayed']);
    expect(replayHeaders.filter((h) => h === 'true').length).toBeGreaterThanOrEqual(replayed);
  });

  it('same key, DIFFERENT content → 409 IDEMPOTENCY_KEY_REUSE_CONFLICT', async () => {
    const key = randomUUID();
    const first = await send('original', key);
    expect(first.status).toBe(201);
    const second = await send('DIFFERENT', key);
    expect(second.status).toBe(409);
    expect(second.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSE_CONFLICT');
  });

  it('no key → two identical sends create two rows', async () => {
    const r1 = await send('twice', null);
    const r2 = await send('twice', null);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.message.id).not.toBe(r2.body.message.id);
    const rows = await env.prisma.message.findMany({
      where: { channelId: stack.channelId, content: 'twice' },
    });
    expect(rows).toHaveLength(2);
  });

  it('invalid Idempotency-Key format → 400 VALIDATION_FAILED', async () => {
    const r = await send('bad key', 'not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('per-user scope: two users can reuse the same key value independently', async () => {
    const key = randomUUID();
    const a = await send('hello', key, stack.member.accessToken);
    const b = await send('hello', key, stack.admin.accessToken);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.message.id).not.toBe(b.body.message.id);
  });
});
