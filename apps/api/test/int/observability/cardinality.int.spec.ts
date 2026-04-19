import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { MsgIntEnv, bearer, seedMessageStack, setupMsgIntEnv } from '../messages/helpers';

/**
 * Realistic-ish workload, then count metric series. This is the guard that
 * catches a "userId accidentally made it into a label" regression — those
 * bugs balloon cardinality linearly with active users.
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

describe('cardinality guard', () => {
  it('metric series count stays bounded after 50 mixed requests', async () => {
    // Simulate a burst: 20 message sends + 10 lists + 10 bad paths +
    // 10 auth failures. Each touches a different code path so a buggy
    // label choice would pop out here.
    for (let i = 0; i < 20; i++) {
      await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set(bearer(stack.member.accessToken))
        .set('idempotency-key', randomUUID())
        .send({ content: `card ${i}` })
        .expect(201);
    }
    for (let i = 0; i < 10; i++) {
      await request(env.baseUrl)
        .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set(bearer(stack.member.accessToken))
        .expect(200);
    }
    for (let i = 0; i < 10; i++) {
      await request(env.baseUrl).get(`/does-not-exist/${randomUUID()}`).expect(404);
    }
    for (let i = 0; i < 10; i++) {
      await request(env.baseUrl)
        .post('/auth/login')
        .send({ email: `ghost-${i}@example.test`, password: 'Wrong123!' })
        .expect(401);
    }

    const res = await request(env.baseUrl).get('/metrics').expect(200);
    const lines = res.text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    // Per-family series counts — not total lines, because histograms emit
    // a line per bucket. We just ensure NO family explodes.
    const counts = new Map<string, number>();
    for (const line of lines) {
      const name = line.split(/[{\s]/)[0];
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) {
      expect(count, `family ${name} cardinality`).toBeLessThan(500);
    }
    // Total series ceiling — generous to accommodate prom-client defaults.
    expect(lines.length).toBeLessThan(1500);
  }, 120_000);
});
