/**
 * Task-016-C-3: POST /feedback integration.
 *   - happy path: category + content → row created, response returns id + createdAt.
 *   - unauthenticated → 401.
 *   - empty content → 400 VALIDATION_FAILED.
 *   - content > 2000 chars → 400.
 *   - unknown category → 400.
 *   - rate limit 5/hour/user → 429 on the 6th.
 *   - captures `page` (Referer) + `userAgent` (UA header).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from '../workspaces/helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // Clear feedback rate-limit keys between specs so the 6-in-a-row
  // case doesn't poison sibling tests.
  const keys = await env.redis.keys('rl:feedback:*');
  if (keys.length > 0) await env.redis.del(...keys);
});

describe('POST /feedback (task-016-C-3)', () => {
  it('authenticated user can submit a BUG feedback; row persists with page + UA', async () => {
    const user = await signupAsUser(env.baseUrl, 'fbu');
    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('origin', ORIGIN)
      .set('referer', 'http://localhost:45173/w/test-ws/general')
      .set('user-agent', 'E2E-Test/1.0')
      .send({ category: 'BUG', content: 'thread panel flickers on reply' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();

    const row = await env.prisma.feedback.findUnique({ where: { id: r.body.id } });
    expect(row).toBeTruthy();
    expect(row?.category).toBe('BUG');
    expect(row?.content).toBe('thread panel flickers on reply');
    expect(row?.userId).toBe(user.userId);
    expect(row?.page).toBe('http://localhost:45173/w/test-ws/general');
    expect(row?.userAgent).toBe('E2E-Test/1.0');
  });

  it('unauthenticated → 401', async () => {
    const r = await request(env.baseUrl)
      .post('/feedback')
      .send({ category: 'OTHER', content: 'hello' });
    expect(r.status).toBe(401);
  });

  it('empty content → 400 VALIDATION_FAILED', async () => {
    const user = await signupAsUser(env.baseUrl, 'fbe');
    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ category: 'OTHER', content: '   ' });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('content > 2000 chars → 400 VALIDATION_FAILED', async () => {
    const user = await signupAsUser(env.baseUrl, 'fbx');
    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ category: 'FEATURE', content: 'x'.repeat(2001) });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('unknown category → 400 VALIDATION_FAILED', async () => {
    const user = await signupAsUser(env.baseUrl, 'fbc');
    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ category: 'RANT', content: 'x' });
    expect(r.status).toBe(400);
  });

  it('6 submissions in an hour → 429 on the 6th', async () => {
    const user = await signupAsUser(env.baseUrl, 'fbr');
    for (let i = 0; i < 5; i++) {
      const r = await request(env.baseUrl)
        .post('/feedback')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ category: 'OTHER', content: `msg ${i}` });
      expect(r.status).toBe(201);
    }
    const sixth = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ category: 'OTHER', content: 'one too many' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.errorCode).toBe('RATE_LIMITED');
  }, 30_000);
});
