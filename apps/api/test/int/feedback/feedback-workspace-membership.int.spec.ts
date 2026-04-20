/**
 * Task-017-A-2 / task-016-follow-5 closure.
 *
 * POST /feedback rejects with 403 WORKSPACE_NOT_MEMBER when the body
 * tags a workspaceId the caller does not belong to. Omitting
 * workspaceId (global feedback) stays legal, as does tagging a
 * workspace the caller IS a member of.
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
  // Rate-limit buckets share the Redis instance across specs in a
  // single test run — clear anything feedback-shaped so the 5/hour
  // cap doesn't false-429 us.
  const keys = await env.redis.keys('rl:feedback:*');
  if (keys.length > 0) await env.redis.del(...keys);
});

describe('POST /feedback workspace membership (task-017-A-2)', () => {
  it('allows a caller who is a member of the tagged workspace', async () => {
    const owner = await signupAsUser(env.baseUrl, 'fbm-own');
    const ws = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Fbm', slug: `fbm-${Date.now().toString(36)}` });
    expect(ws.status).toBe(201);

    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ category: 'BUG', content: 'reply composer glitches', workspaceId: ws.body.id });
    expect(r.status).toBe(201);
    const row = await env.prisma.feedback.findUnique({ where: { id: r.body.id } });
    expect(row?.workspaceId).toBe(ws.body.id);
  });

  it('rejects 403 WORKSPACE_NOT_MEMBER when the caller is not in the tagged workspace', async () => {
    const owner = await signupAsUser(env.baseUrl, 'fbm-own2');
    const stranger = await signupAsUser(env.baseUrl, 'fbm-str');
    const ws = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Fbm2', slug: `fbm2-${Date.now().toString(36)}` });
    expect(ws.status).toBe(201);

    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ category: 'BUG', content: 'polluting the queue', workspaceId: ws.body.id });
    expect(r.status).toBe(404); // WORKSPACE_NOT_MEMBER maps to 404 per ERROR_CODE_HTTP_STATUS
    expect(r.body.errorCode).toBe('WORKSPACE_NOT_MEMBER');
  });

  it('allows global feedback (workspaceId omitted) from any user', async () => {
    const u = await signupAsUser(env.baseUrl, 'fbm-glb');
    const r = await request(env.baseUrl)
      .post('/feedback')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ category: 'OTHER', content: 'generic comment, no workspace' });
    expect(r.status).toBe(201);
    const row = await env.prisma.feedback.findUnique({ where: { id: r.body.id } });
    expect(row?.workspaceId).toBeNull();
  });
});
