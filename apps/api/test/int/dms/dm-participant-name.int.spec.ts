import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * task-039-A regression spec for hot-fix `e678195`. The DM list
 * (`GET /me/dms`) must always carry the other participant's username.
 * Earlier, `MessageList`'s author-name lookup fell back to "unknown"
 * for users not in the viewer's workspace; the list endpoint itself
 * should never expose that placeholder.
 */
describe('Global DM list participant name (int)', () => {
  let env: DmIntEnv;
  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    env = await setupDmIntEnv();
    alice = await signup(env.baseUrl, 'dna');
    bob = await signup(env.baseUrl, 'dnb');
    await makeFriends(env.baseUrl, alice, bob);
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: bob.userId });
    if (dm.status >= 400) throw new Error(`createDm: ${dm.status} ${dm.text}`);
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  });

  it('returns Bob as the otherUsername for Alice', async () => {
    const list = await request(env.baseUrl).get('/me/dms').set(bearer(alice.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    const row = list.body.items.find((d: { otherUserId: string }) => d.otherUserId === bob.userId);
    expect(row).toBeDefined();
    expect(row.otherUsername).toBe(bob.username);
    expect(row.otherUsername).not.toMatch(/unknown/i);
    expect(row.otherUsername).not.toBe(null);
    expect(row.otherUsername).not.toBe('');
  });

  it('returns Alice as the otherUsername for Bob (symmetric)', async () => {
    const list = await request(env.baseUrl).get('/me/dms').set(bearer(bob.accessToken));
    expect(list.status).toBe(200);
    const row = list.body.items.find(
      (d: { otherUserId: string }) => d.otherUserId === alice.userId,
    );
    expect(row).toBeDefined();
    expect(row.otherUsername).toBe(alice.username);
    expect(row.otherUsername).not.toMatch(/unknown/i);
  });

  it('whole list never carries "unknown" / null / empty username', async () => {
    const list = await request(env.baseUrl).get('/me/dms').set(bearer(alice.accessToken));
    for (const row of list.body.items as Array<{ otherUsername: string | null }>) {
      expect(row.otherUsername).toBeTruthy();
      expect(row.otherUsername).not.toMatch(/unknown/i);
    }
  });
});
