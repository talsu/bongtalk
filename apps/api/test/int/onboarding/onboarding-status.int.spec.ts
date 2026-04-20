/**
 * Task-016-C-1: GET /me/onboarding-status — the four counters that
 * drive the sidebar checklist.
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

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('GET /me/onboarding-status (task-016-C-1)', () => {
  it('brand-new user returns all zeros', async () => {
    const u = await signupAsUser(env.baseUrl, 'ob0');
    const r = await request(env.baseUrl)
      .get('/me/onboarding-status')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ workspaces: 0, channels: 0, invitesIssued: 0, messagesSent: 0 });
  });

  it('counts increment as user creates a workspace, channel, invite, and message', async () => {
    const u = await signupAsUser(env.baseUrl, 'ob1');
    // Step 1: create a workspace (auto-creates #general as the default
    // channel so channels starts at 1).
    const ws = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ name: 'ObTest', slug: `ob-${Date.now().toString(36)}` })
      .expect(201);

    let r = await request(env.baseUrl)
      .get('/me/onboarding-status')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(r.body.workspaces).toBe(1);
    expect(r.body.channels).toBeGreaterThanOrEqual(1);
    expect(r.body.invitesIssued).toBe(0);
    expect(r.body.messagesSent).toBe(0);

    // Step 2: add a second channel.
    const ch2 = await request(env.baseUrl)
      .post(`/workspaces/${ws.body.id}/channels`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ name: 'second', type: 'TEXT' });
    expect(ch2.status).toBe(201);

    // Step 3: issue an invite.
    await request(env.baseUrl)
      .post(`/workspaces/${ws.body.id}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ maxUses: 5 })
      .expect(201);

    // Step 4: send a message on the new channel.
    await request(env.baseUrl)
      .post(`/workspaces/${ws.body.id}/channels/${ch2.body.id}/messages`)
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ content: 'first message!' })
      .expect(201);

    r = await request(env.baseUrl)
      .get('/me/onboarding-status')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(r.body.workspaces).toBe(1);
    expect(r.body.channels).toBeGreaterThanOrEqual(2);
    expect(r.body.invitesIssued).toBeGreaterThanOrEqual(1);
    expect(r.body.messagesSent).toBeGreaterThanOrEqual(1);
  });
});
