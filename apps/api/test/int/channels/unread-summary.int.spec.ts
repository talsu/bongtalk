import { randomUUID } from 'node:crypto';
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
    .set('idempotency-key', randomUUID())
    .send({ content, mentions });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
}

/**
 * Task-010-B integration test.
 * - POST /channels/:chid/read upserts lastReadAt = now().
 * - GET /workspaces/:id/unread-summary returns one row per channel; counts
 *   only messages after the caller's lastReadAt AND authored by other
 *   users (caller's own sends never pile up).
 * - Mentions detected via jsonb containment; `everyone=true` also lights
 *   hasMention.
 */
describe('unread summary + mark-read (task-010-B)', () => {
  it('counts only messages posted after lastReadAt and by other users', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'general');

    await postMessage(workspaceId, channel.id, owner.accessToken, 'pre-1');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'pre-2');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'pre-3');

    const markRes = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channel.id}/read`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(markRes.status).toBe(204);

    vi.setSystemTime(new Date('2025-01-01T01:00:00Z'));
    await postMessage(workspaceId, channel.id, owner.accessToken, 'post-1');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'post-2');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'post-3');
    await postMessage(workspaceId, channel.id, member.accessToken, 'self');

    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(sumRes.status).toBe(200);
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    expect(row).toBeDefined();
    expect(row.unreadCount).toBe(3);
    expect(row.hasMention).toBe(false);
    expect(row.lastMessageAt).toBeTruthy();
  });

  it('lights hasMention on explicit user mention', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'mentions');
    await postMessage(workspaceId, channel.id, owner.accessToken, `hey @${member.username}`, {
      users: [member.userId],
      channels: [],
      everyone: false,
    });
    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    expect(row.unreadCount).toBe(1);
    expect(row.hasMention).toBe(true);
  });

  it('lights hasMention on @everyone', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'announce');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'attention', {
      users: [],
      channels: [],
      everyone: true,
    });
    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    expect(row.hasMention).toBe(true);
  });

  it('does not count the caller-authored messages as unread', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'solo');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'own-1');
    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    expect(row.unreadCount).toBe(0);
  });
});
