/**
 * task-031-C: PATCH /workspaces/:id integration — visibility flips
 * require OWNER + merged category/description; ADMIN rejected; rate
 * limit 10/hour/workspace on visibility.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('PATCH /workspaces/:id visibility', () => {
  it('OWNER flip with category+description; ADMIN blocked; rate-limits at 10/hour', async () => {
    const owner = await signupAsUser(env.baseUrl, 'vt');
    const stamp = Date.now().toString(36);
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'VtPriv', slug: `vt-${stamp}` });
    const wsId = create.body.id as string;

    // Missing category/description → 422.
    const bad = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visibility: 'PUBLIC' });
    expect(bad.status).toBe(422);

    // With both → 200.
    const good = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visibility: 'PUBLIC', category: 'MUSIC', description: 'good music' });
    expect(good.status).toBe(200);

    // ADMIN attempt — signed up admin, invited + accepted, promoted,
    // then PATCH visibility → 403.
    const admin = await signupAsUser(env.baseUrl, 'vta');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/invites`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    const code = inv.body.code as string;
    await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    await request(env.baseUrl)
      .patch(`/workspaces/${wsId}/members/${admin.userId}/role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'ADMIN' });
    const adminFlip = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ visibility: 'PRIVATE' });
    expect(adminFlip.status).toBe(403);

    // Rate limit: we've used 2 hits already (bad + good). Burn to 10
    // then one more → 429.
    for (let i = 0; i < 8; i += 1) {
      await request(env.baseUrl)
        .patch(`/workspaces/${wsId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          visibility: i % 2 === 0 ? 'PRIVATE' : 'PUBLIC',
          category: 'MUSIC',
          description: 'good music',
        });
    }
    const limited = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visibility: 'PUBLIC', category: 'MUSIC', description: 'good music' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
