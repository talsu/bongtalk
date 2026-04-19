import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  const rlKeys = await env.redis.keys('rl:msg:*');
  if (rlKeys.length > 0) await env.redis.del(...rlKeys);
});

describe('Messages CRUD + soft delete', () => {
  it('POST create → GET one → PATCH edit → DELETE soft', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'hello world' });
    expect(post.status).toBe(201);
    const msgId = post.body.message.id;
    expect(post.body.message.content).toBe('hello world');
    expect(post.body.message.edited).toBe(false);
    expect(post.body.message.deleted).toBe(false);

    const get = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.admin.accessToken));
    expect(get.status).toBe(200);
    expect(get.body.message.content).toBe('hello world');

    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'hello edited' });
    expect(patch.status).toBe(200);
    expect(patch.body.message.content).toBe('hello edited');
    expect(patch.body.message.edited).toBe(true);

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(del.status).toBe(204);
  });

  it('soft-deleted messages hide content but keep the row (audit)', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'secret content' });
    const msgId = post.body.message.id;
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    // Default list hides the row entirely
    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.items.find((m: { id: string }) => m.id === msgId)).toBeUndefined();

    // Admin + includeDeleted=true returns the row with content masked
    const all = await request(env.baseUrl)
      .get(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?includeDeleted=true`,
      )
      .set(bearer(stack.admin.accessToken));
    expect(all.status).toBe(200);
    const found = all.body.items.find((m: { id: string }) => m.id === msgId);
    expect(found).toBeDefined();
    expect(found.deleted).toBe(true);
    expect(found.content).toBeNull();

    // DB row still has content (audit)
    const raw = await env.prisma.message.findUnique({ where: { id: msgId } });
    expect(raw?.content).toBe('secret content');
    expect(raw?.deletedAt).not.toBeNull();
  });

  it('GET one rejects id from a different channel (IDOR defence)', async () => {
    // Create a second channel; message in channel A should not be reachable
    // via channel B's path.
    const otherCh = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set(bearer(stack.owner.accessToken))
      .send({ name: `other-${Date.now().toString(36).slice(-5)}`, type: 'TEXT' });
    const otherId = otherCh.body.id;

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'in original' });
    const msgId = post.body.message.id;

    const cross = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${otherId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(cross.status).toBe(404);
    expect(cross.body.errorCode).toBe('MESSAGE_NOT_FOUND');
  });

  it('POST into archived channel returns 409 CHANNEL_ARCHIVED', async () => {
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/archive`)
      .set(bearer(stack.owner.accessToken))
      .expect(201);
    const res = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'blocked' });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('CHANNEL_ARCHIVED');
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/unarchive`)
      .set(bearer(stack.owner.accessToken));
  });

  it('content validation: empty → 422, >4000 → 422', async () => {
    const empty = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: '' });
    expect(empty.status).toBe(422);
    expect(empty.body.errorCode).toBe('MESSAGE_CONTENT_INVALID');

    const oversize = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'a'.repeat(4001) });
    expect(oversize.status).toBe(422);
  });
});
