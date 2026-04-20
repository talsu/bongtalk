import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from '../messages/helpers';

/**
 * Smokes the Prometheus exposition endpoint end-to-end:
 *   - `/metrics` returns valid exposition text (name HELP TYPE value)
 *   - domain counters actually tick when the corresponding business event
 *     fires
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
  const keys = await env.redis.keys('rl:msg:*');
  if (keys.length > 0) await env.redis.del(...keys);
});

function parseExposition(body: string): Record<string, number> {
  // Very small parser: for `name{labels} value` lines aggregate by name.
  const sums: Record<string, number> = {};
  for (const line of body.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    const name = parts[0].split('{')[0];
    const value = Number(parts[parts.length - 1]);
    if (!Number.isFinite(value)) continue;
    sums[name] = (sums[name] ?? 0) + value;
  }
  return sums;
}

async function scrape(): Promise<Record<string, number>> {
  const res = await request(env.baseUrl).get('/metrics').expect(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
  return parseExposition(res.text);
}

describe('Prometheus exposition', () => {
  it('/metrics serves Prometheus text format', async () => {
    const res = await request(env.baseUrl).get('/metrics');
    expect(res.status).toBe(200);
    // Must include a HELP line for a well-known metric.
    expect(res.text).toMatch(/^# HELP http_requests_total /m);
    // Must include a TYPE line.
    expect(res.text).toMatch(/^# TYPE http_requests_total counter$/m);
  });

  it('messages_sent_total increments on successful POST', async () => {
    const before = await scrape();
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'tick' })
      .expect(201);
    const after = await scrape();
    const delta = (after['messages_sent_total'] ?? 0) - (before['messages_sent_total'] ?? 0);
    expect(delta).toBe(1);
  });

  it('http_requests_total grows by at least 1 on any GET', async () => {
    const before = await scrape();
    await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels`)
      .set(bearer(stack.member.accessToken))
      .expect(200);
    const after = await scrape();
    const delta = (after['http_requests_total'] ?? 0) - (before['http_requests_total'] ?? 0);
    expect(delta).toBeGreaterThanOrEqual(1);
  });
});
