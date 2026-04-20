/**
 * Task-013-B: MessageReaction API. Covers:
 *   - POST add → idempotent repeat returns the same count (no 409)
 *   - DELETE own emoji → no-op delete is still 204
 *   - GET list/getOne exposes `reactions: [{ emoji, count, byMe }]`
 *   - codepoint cap (>4) rejected with VALIDATION_FAILED
 *   - non-member (no READ) gets 403 via ChannelAccessByIdGuard
 *   - outbox `message.reaction.added` / `.removed` rows are written
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, bearer, seedMessageStack, setupMsgIntEnv } from '../messages/helpers';

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
  await env.prisma.messageReaction.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  const rlKeys = await env.redis.keys('rl:*');
  if (rlKeys.length > 0) await env.redis.del(...rlKeys);
});

async function postMessage(token: string, content = 'reactable'): Promise<string> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content });
  if (r.status !== 201) throw new Error(`post: ${r.status} ${r.text}`);
  return r.body.message.id as string;
}

describe('Reactions API (task-013-B)', () => {
  it('add → idempotent re-add → list shows count=1/byMe=true', async () => {
    const msgId = await postMessage(stack.member.accessToken);

    const a1 = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(a1.status).toBe(201);
    expect(a1.body).toMatchObject({ emoji: '👍', count: 1, byMe: true });

    // Idempotent repeat: same row → same count, still 201 (no 409).
    const a2 = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '👍' });
    expect(a2.status).toBe(201);
    expect(a2.body.count).toBe(1);

    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken));
    expect(list.status).toBe(200);
    const found = list.body.items.find((m: { id: string }) => m.id === msgId);
    expect(found.reactions).toEqual([{ emoji: '👍', count: 1, byMe: true }]);

    // admin viewing — byMe must be false since admin hasn't reacted.
    const listAdmin = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.admin.accessToken));
    const adminView = listAdmin.body.items.find((m: { id: string }) => m.id === msgId);
    expect(adminView.reactions).toEqual([{ emoji: '👍', count: 1, byMe: false }]);
  });

  it('DELETE own reaction → 204, row gone', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '🎉' })
      .expect(201);

    const del = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions/${encodeURIComponent('🎉')}`)
      .set(bearer(stack.member.accessToken));
    expect(del.status).toBe(204);

    // Second delete is a silent no-op (still 204) so the UI can be optimistic.
    const del2 = await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions/${encodeURIComponent('🎉')}`)
      .set(bearer(stack.member.accessToken));
    expect(del2.status).toBe(204);

    const one = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(one.body.message.reactions).toEqual([]);
  });

  it('rejects emoji >4 codepoints with VALIDATION_FAILED', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    const tooLong = '👍👎🎉🔥❤️'; // 5 codepoints
    const r = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: tooLong });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/VALIDATION_FAILED/);
  });

  it('non-member is rejected by ChannelAccessByIdGuard (403)', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    const r = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.nonMember.accessToken))
      .send({ emoji: '👍' });
    expect([401, 403]).toContain(r.status);
  });

  it('outbox emits message.reaction.added + message.reaction.removed', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set(bearer(stack.member.accessToken))
      .send({ emoji: '✨' })
      .expect(201);
    await request(env.baseUrl)
      .delete(`/messages/${msgId}/reactions/${encodeURIComponent('✨')}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateId: msgId, eventType: { startsWith: 'message.reaction.' } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'message.reaction.added',
      'message.reaction.removed',
    ]);
    // payload carries channelId for the dispatcher's room routing.
    expect((events[0].payload as { channelId: string }).channelId).toBe(stack.channelId);
  });

  it('multiple users on the same emoji sum in count, distinct byMe', async () => {
    const msgId = await postMessage(stack.member.accessToken);
    for (const a of [stack.member, stack.admin, stack.owner]) {
      await request(env.baseUrl)
        .post(`/messages/${msgId}/reactions`)
        .set(bearer(a.accessToken))
        .send({ emoji: '🚀' })
        .expect(201);
    }
    const one = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken));
    expect(one.body.message.reactions).toEqual([{ emoji: '🚀', count: 3, byMe: true }]);
  });
});
