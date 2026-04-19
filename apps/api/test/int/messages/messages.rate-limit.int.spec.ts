import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const keys = await env.redis.keys('rl:msg:*');
  if (keys.length > 0) await env.redis.del(...keys);
});

describe('Message POST rate limiting', () => {
  it('30/10sec per user: 30 accepted, 31st = 429 RATE_LIMITED', async () => {
    process.env.MESSAGE_RATE_USER_MAX = '30';
    process.env.MESSAGE_RATE_CHANNEL_MAX = '60';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const r = await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(stack.member.accessToken))
        .send({ content: `spam ${i}` });
      statuses.push(r.status);
    }
    const ok = statuses.filter((s) => s === 201).length;
    const limited = statuses.filter((s) => s === 429).length;
    expect(ok).toBe(30);
    expect(limited).toBe(1);
    // Reset for subsequent tests
    process.env.MESSAGE_RATE_USER_MAX = '10000';
  });

  it('TTL on the rate-limit key is <= 10 seconds', async () => {
    process.env.MESSAGE_RATE_USER_MAX = '30';
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ content: 'first' })
      .expect(201);
    const ttl = await env.redis.ttl(`rl:msg:send:u:${stack.admin.userId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
    process.env.MESSAGE_RATE_USER_MAX = '10000';
  });
});
