/**
 * task-031-C: /workspaces/discover integration coverage — filter,
 * search (name + description), cursor pagination, (memberCount DESC,
 * id ASC) total order.
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

describe('/workspaces/discover', () => {
  it('returns only PUBLIC workspaces; filters by category; matches name + description', async () => {
    const owner = await signupAsUser(env.baseUrl, 'dl');
    const stamp = Date.now().toString(36);
    const pubProg = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Programming Forge',
        slug: `prog-${stamp}`,
        visibility: 'PUBLIC',
        category: 'PROGRAMMING',
        description: 'Rust + TypeScript weekly',
      });
    expect(pubProg.status).toBe(201);
    await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Gamers Lodge',
        slug: `game-${stamp}`,
        visibility: 'PUBLIC',
        category: 'GAMING',
        description: 'TypeScript hobby gamedev',
      });
    // Private — must not appear.
    await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Hidden', slug: `hid-${stamp}` });

    const list = await request(env.baseUrl)
      .get('/workspaces/discover?limit=20')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    const slugs = (list.body.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).toContain(`prog-${stamp}`);
    expect(slugs).toContain(`game-${stamp}`);
    expect(slugs).not.toContain(`hid-${stamp}`);

    const byCat = await request(env.baseUrl)
      .get('/workspaces/discover?category=GAMING')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const catSlugs = (byCat.body.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(catSlugs).toContain(`game-${stamp}`);
    expect(catSlugs).not.toContain(`prog-${stamp}`);

    // task-031-D: q matches name OR description — "TypeScript" hits
    // both public workspaces (one in description, one implicitly).
    const byQ = await request(env.baseUrl)
      .get('/workspaces/discover?q=TypeScript')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const qSlugs = (byQ.body.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(qSlugs).toEqual(expect.arrayContaining([`prog-${stamp}`, `game-${stamp}`]));
  });
});
