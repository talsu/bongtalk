import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { bearer, type ChIntEnv, ORIGIN, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';

let env: ChIntEnv;

beforeAll(async () => {
  env = await setupChIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(
  workspaceId: string,
  ownerToken: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(ownerToken))
    .send({ name, type: 'TEXT' });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return { id: res.body.id, name: res.body.name };
}

async function postMessage(
  workspaceId: string,
  channelId: string,
  token: string,
  content: string,
  mentions: { users?: string[]; channels?: string[]; everyone?: boolean } = {},
): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content, mentions });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
}

describe('GET /me/unread-totals (task-018-E)', () => {
  it('aggregates unread counts by workspace in a single query', async () => {
    const a = await seedWorkspaceWithRoles(env.baseUrl);
    const b = await seedWorkspaceWithRoles(env.baseUrl);

    const chA = await createChannel(a.workspaceId, a.owner.accessToken, 'general');
    const chB = await createChannel(b.workspaceId, b.owner.accessToken, 'general');

    await postMessage(a.workspaceId, chA.id, a.owner.accessToken, 'a1');
    await postMessage(a.workspaceId, chA.id, a.owner.accessToken, 'a2');
    await postMessage(b.workspaceId, chB.id, b.owner.accessToken, 'b1');

    // Viewer is `a.member` — belongs to workspace A only, so totals should
    // contain exactly one entry (workspace A) with count 2.
    const aRes = await request(env.baseUrl)
      .get('/me/unread-totals')
      .set('origin', ORIGIN)
      .set(bearer(a.member.accessToken));
    expect(aRes.status).toBe(200);
    expect(aRes.body.totals).toHaveLength(1);
    expect(aRes.body.totals[0].workspaceId).toBe(a.workspaceId);
    expect(aRes.body.totals[0].unreadCount).toBe(2);
    expect(aRes.body.totals[0].hasMention).toBe(false);
  });

  it('lights hasMention when an @everyone or @user message is unread', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel(workspaceId, owner.accessToken, 'general');
    await postMessage(workspaceId, ch.id, owner.accessToken, '@everyone heads up', {
      everyone: true,
    });

    const res = await request(env.baseUrl)
      .get('/me/unread-totals')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(res.status).toBe(200);
    const entry = res.body.totals.find(
      (t: { workspaceId: string }) => t.workspaceId === workspaceId,
    );
    expect(entry).toBeDefined();
    expect(entry.unreadCount).toBe(1);
    expect(entry.hasMention).toBe(true);
  });

  it('returns an entry per workspace even when unread is zero (for rail render)', async () => {
    const { workspaceId, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .get('/me/unread-totals')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(res.status).toBe(200);
    const entry = res.body.totals.find(
      (t: { workspaceId: string }) => t.workspaceId === workspaceId,
    );
    expect(entry).toBeDefined();
    expect(entry.unreadCount).toBe(0);
    expect(entry.hasMention).toBe(false);
  });
});
