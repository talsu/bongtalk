import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, type ChIntEnv, ORIGIN, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';

let env: ChIntEnv;

beforeAll(async () => {
  env = await setupChIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

/**
 * Task-019-D: GET + PUT /me/notification-preferences.
 *
 * Covers:
 *   - Empty GET returns no rows for a fresh user.
 *   - PUT upserts; second PUT with the same (workspaceId, eventType)
 *     updates in place (no duplicate rows).
 *   - PUT with a workspaceId the caller is not in → 404 WORKSPACE_NOT_MEMBER.
 *   - PUT with workspaceId=null (global default) always allowed.
 *   - Invalid eventType / channel rejected with VALIDATION_FAILED.
 */
describe('/me/notification-preferences (task-019-D)', () => {
  it('empty list for a fresh user', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .get('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual([]);
  });

  it('PUT upserts the same (ws, eventType) without duplicating', async () => {
    const { workspaceId, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const r1 = await request(env.baseUrl)
      .put('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ workspaceId, eventType: 'MENTION', channel: 'OFF' });
    expect(r1.status).toBe(200);
    const r2 = await request(env.baseUrl)
      .put('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ workspaceId, eventType: 'MENTION', channel: 'BOTH' });
    expect(r2.status).toBe(200);
    const listRes = await request(env.baseUrl)
      .get('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const matching = (
      listRes.body.preferences as Array<{ workspaceId: string; channel: string }>
    ).filter((p) => p.workspaceId === workspaceId);
    expect(matching).toHaveLength(1);
    expect(matching[0].channel).toBe('BOTH');
  });

  it('PUT with a foreign workspaceId → 404 WORKSPACE_NOT_MEMBER', async () => {
    const a = await seedWorkspaceWithRoles(env.baseUrl);
    const b = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .put('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(a.member.accessToken))
      .send({ workspaceId: b.workspaceId, eventType: 'MENTION', channel: 'OFF' });
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('WORKSPACE_NOT_MEMBER');
  });

  it('PUT with workspaceId=null is the global default and always allowed', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .put('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ workspaceId: null, eventType: 'REPLY', channel: 'OFF' });
    expect(res.status).toBe(200);
  });

  it('rejects invalid eventType / channel with VALIDATION_FAILED', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    const bad1 = await request(env.baseUrl)
      .put('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ workspaceId: null, eventType: 'BOGUS', channel: 'OFF' });
    expect(bad1.status).toBe(400);
    expect(bad1.body.errorCode).toBe('VALIDATION_FAILED');

    const bad2 = await request(env.baseUrl)
      .put('/me/notification-preferences')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ workspaceId: null, eventType: 'MENTION', channel: 'NUCLEAR' });
    expect(bad2.status).toBe(400);
    expect(bad2.body.errorCode).toBe('VALIDATION_FAILED');
  });
});
