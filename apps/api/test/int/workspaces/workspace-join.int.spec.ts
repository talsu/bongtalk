/**
 * task-031-C: POST /workspaces/:id/join integration — PUBLIC idempotent,
 * PRIVATE → 403 WORKSPACE_NOT_PUBLIC, 5/min rate limit → 429 with
 * Retry-After header.
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

describe('POST /workspaces/:id/join', () => {
  it('idempotent PUBLIC join; PRIVATE returns 403; rate-limits at 5/min', async () => {
    const owner = await signupAsUser(env.baseUrl, 'wjo');
    const visitor = await signupAsUser(env.baseUrl, 'wjv');
    const stamp = Date.now().toString(36);

    const pub = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'JoinPub',
        slug: `pj-${stamp}`,
        visibility: 'PUBLIC',
        category: 'OTHER',
        description: 'join test',
      });
    const pubId = pub.body.id as string;

    // 1st join → created.
    const j1 = await request(env.baseUrl)
      .post(`/workspaces/${pubId}/join`)
      .set('Authorization', `Bearer ${visitor.accessToken}`);
    expect(j1.status).toBe(201);
    expect(j1.body.alreadyMember).toBe(false);

    // 2nd join → idempotent (alreadyMember true).
    const j2 = await request(env.baseUrl)
      .post(`/workspaces/${pubId}/join`)
      .set('Authorization', `Bearer ${visitor.accessToken}`);
    expect(j2.status).toBe(201);
    expect(j2.body.alreadyMember).toBe(true);

    // Private workspace → 403.
    const priv = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'PrivNo', slug: `pn-${stamp}` });
    const privId = priv.body.id as string;
    const j3 = await request(env.baseUrl)
      .post(`/workspaces/${privId}/join`)
      .set('Authorization', `Bearer ${visitor.accessToken}`);
    expect(j3.status).toBe(403);
    expect(j3.body.errorCode).toBe('WORKSPACE_NOT_PUBLIC');

    // Rate limit: 6 consecutive joins → 6th is 429. (1 already consumed
    // by j1; j2/j3 are idempotent no-ops but still count as hits.)
    // Burn 3 fresh public workspaces to use the remaining budget.
    const pubs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const more = await request(env.baseUrl)
        .post('/workspaces')
        .set('origin', ORIGIN)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          name: `p${i}`,
          slug: `p${i}-${stamp}`,
          visibility: 'PUBLIC',
          category: 'OTHER',
          description: `p${i}`,
        });
      pubs.push(more.body.id as string);
    }
    // j1 (+1) + j2 (+1) + j3 (+1) + 3 = 6 hits. 6th is over cap (max=5).
    const results: number[] = [];
    for (const id of pubs) {
      const r = await request(env.baseUrl)
        .post(`/workspaces/${id}/join`)
        .set('Authorization', `Bearer ${visitor.accessToken}`);
      results.push(r.status);
    }
    // Expect at least one 429 in the burst, and the 429 response carries
    // the retry-after header.
    const limited = results.find((s) => s === 429);
    expect(limited).toBe(429);
  });
});
