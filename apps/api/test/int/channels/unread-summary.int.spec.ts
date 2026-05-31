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

/**
 * Task-010-B → S11 (FR-RT-14/19) integration test.
 * - POST /channels/:chid/read (deprecated) now marks up to the channel's
 *   latest message via the monotonic (createdAt, id) tuple cursor.
 * - GET /workspaces/:id/unread-summary returns one row per channel; counts
 *   every message whose (createdAt, id) tuple is GREATER than the caller's
 *   read cursor. S11 change: the caller's OWN sends DO count (no
 *   senderId-exclusion) — FR-RT-14.
 * - Mentions detected via jsonb containment; `everyone=true` also lights
 *   hasMention.
 */
describe('unread summary + mark-read (task-010-B → S11 tuple cursor)', () => {
  it('counts every message after the read cursor, including the caller-authored ones (FR-RT-14)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'general');

    await postMessage(workspaceId, channel.id, owner.accessToken, 'pre-1');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'pre-2');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'pre-3');

    // Deprecated /read marks up to the latest message (pre-3) at this moment.
    const markRes = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channel.id}/read`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(markRes.status).toBe(204);

    // Advance the clock by 1s (well under the 15m access-token TTL) so these
    // posts get a strictly-greater createdAt than the cursor. Message.id is a
    // RANDOM uuid, so we must NOT rely on id ordering for "happened after" —
    // the createdAt component of the tuple does that work here.
    vi.setSystemTime(new Date('2025-01-01T00:00:01Z'));
    await postMessage(workspaceId, channel.id, owner.accessToken, 'post-1');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'post-2');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'post-3');
    // S11: a self-authored send AFTER the cursor now counts as unread.
    await postMessage(workspaceId, channel.id, member.accessToken, 'self');

    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(sumRes.status).toBe(200);
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    expect(row).toBeDefined();
    // 3 owner posts + 1 self post, all after the cursor.
    expect(row.unreadCount).toBe(4);
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

  it('S11 (FR-RT-14): a caller-authored message with NO read cursor counts as unread (self-inclusive)', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'solo');
    await postMessage(workspaceId, channel.id, owner.accessToken, 'own-1');
    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    // No read-state row ⇒ NULL cursor ⇒ "everything unread", self-inclusive.
    expect(row.unreadCount).toBe(1);
  });

  it('S11 (FR-RT-14): tie on createdAt is broken by message id — only strictly-newer tuples count', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channel = await createChannel(workspaceId, owner.accessToken, 'tie');

    // Three messages share the SAME frozen system time ⇒ identical createdAt.
    // The (createdAt, id) tuple must still order them by id so that acking
    // the middle one leaves exactly the messages with a greater id unread.
    await postMessage(workspaceId, channel.id, owner.accessToken, 't1');
    await postMessage(workspaceId, channel.id, owner.accessToken, 't2');
    await postMessage(workspaceId, channel.id, owner.accessToken, 't3');

    // Fetch the three message ids in canonical (createdAt DESC, id DESC) order.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${channel.id}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{ id: string }>;
    expect(items.length).toBe(3);
    // items[0] = newest tuple, items[2] = oldest tuple. Ack the MIDDLE one.
    const middleId = items[1].id;

    const ackRes = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channel.id}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: middleId });
    expect(ackRes.status).toBe(200);
    // Exactly one message (the newest-tuple one) remains unread.
    expect(ackRes.body.unreadCount).toBe(1);

    const sumRes = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const row = sumRes.body.channels.find((c: { channelId: string }) => c.channelId === channel.id);
    expect(row.unreadCount).toBe(1);
  });
});
