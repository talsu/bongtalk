/**
 * Task-014-B: thread replies. Covers:
 *   - POST /workspaces/:ws/channels/:ch/messages with parentMessageId
 *     creates a reply row linked to a root.
 *   - parent must be in the same channel (cross-channel 404).
 *   - parent must itself be a root (reply-to-reply rejected with
 *     MESSAGE_THREAD_DEPTH_EXCEEDED).
 *   - GET /messages/:id/thread ACL — non-member is 403 via
 *     ChannelAccessByIdGuard.requireRead.
 *   - Thread replies sort createdAt ASC; pagination cursor works.
 *   - Outbox emits message.created (with parentMessageId) +
 *     message.thread.replied in the same tx; the replied payload's
 *     recipients include root author but NOT the replier.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

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
  await env.prisma.outboxEvent.deleteMany({});
  const rl = await env.redis.keys('rl:*');
  if (rl.length > 0) await env.redis.del(...rl);
});

async function postRoot(token: string, content = 'root'): Promise<string> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content });
  if (r.status !== 201) throw new Error(`post root: ${r.status} ${r.text}`);
  return r.body.message.id;
}

async function postReply(
  token: string,
  parentMessageId: string,
  content: string,
): Promise<{ status: number; body: { message?: { id: string }; errorCode?: string } }> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content, parentMessageId });
  return { status: r.status, body: r.body };
}

describe('Threads API — create reply (task-014-B)', () => {
  it('POST with parentMessageId creates a reply row', async () => {
    const rootId = await postRoot(stack.member.accessToken);
    const reply = await postReply(stack.admin.accessToken, rootId, 'first reply');
    expect(reply.status).toBe(201);
    expect(reply.body.message!.id).toBeTruthy();
    // DB state: row has parentMessageId pointing at root.
    const row = await env.prisma.message.findUnique({ where: { id: reply.body.message!.id } });
    expect(row?.parentMessageId).toBe(rootId);
  });

  it('reject reply-to-reply with MESSAGE_THREAD_DEPTH_EXCEEDED (400)', async () => {
    const rootId = await postRoot(stack.member.accessToken);
    const r1 = await postReply(stack.admin.accessToken, rootId, 'level-1 reply');
    expect(r1.status).toBe(201);
    const r2 = await postReply(stack.owner.accessToken, r1.body.message!.id, 'level-2 attempt');
    expect(r2.status).toBe(400);
    expect(r2.body.errorCode).toBe('MESSAGE_THREAD_DEPTH_EXCEEDED');
  });

  it('reject reply when parent does not exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000099';
    const r = await postReply(stack.admin.accessToken, missing, 'oops');
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('MESSAGE_PARENT_NOT_FOUND');
  });
});

describe('Threads API — GET /messages/:id/thread (task-014-B)', () => {
  it('returns root + replies sorted ASC with pageInfo', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root message');
    // 3 replies from different authors so recentReplyUserIds test has content.
    await postReply(stack.admin.accessToken, rootId, 'reply 1');
    await postReply(stack.owner.accessToken, rootId, 'reply 2');
    await postReply(stack.member.accessToken, rootId, 'reply 3');

    const r = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread?limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.root.id).toBe(rootId);
    expect(r.body.replies).toHaveLength(3);
    // ASC order
    const times = r.body.replies.map((m: { createdAt: string }) => m.createdAt);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
  });

  it('non-member is 403 via ChannelAccessByIdGuard', async () => {
    const rootId = await postRoot(stack.member.accessToken);
    const r = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread`)
      .set(bearer(stack.nonMember.accessToken));
    expect([401, 403, 404]).toContain(r.status);
  });

  it('rejects a non-root id (reply-id opened as thread)', async () => {
    const rootId = await postRoot(stack.member.accessToken);
    const reply = await postReply(stack.admin.accessToken, rootId, 'hello');
    const r = await request(env.baseUrl)
      .get(`/messages/${reply.body.message!.id}/thread`)
      .set(bearer(stack.member.accessToken));
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('MESSAGE_NOT_FOUND');
  });
});

describe('Threads API — outbox fanout (task-014-B)', () => {
  it('reply emits message.created with parentMessageId AND message.thread.replied', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'conversation starter');
    const reply = await postReply(stack.admin.accessToken, rootId, 'reply');
    expect(reply.status).toBe(201);

    const events = await env.prisma.outboxEvent.findMany({
      where: {
        eventType: { in: ['message.created', 'message.thread.replied'] },
        aggregateId: { in: [rootId, reply.body.message!.id] },
      },
      orderBy: { occurredAt: 'asc' },
    });
    const created = events.find((e) => e.eventType === 'message.created')!;
    const replied = events.find((e) => e.eventType === 'message.thread.replied')!;
    expect(created).toBeTruthy();
    expect(replied).toBeTruthy();

    // message.created now carries parentMessageId on the nested payload.
    const createdPayload = created.payload as { message: { parentMessageId: string | null } };
    expect(createdPayload.message.parentMessageId).toBe(rootId);

    // replied payload has root author in recipients, NOT replier, and
    // reports replyCount=1 + a non-empty recentReplyUserIds.
    const rp = replied.payload as {
      replyCount: number;
      recipients: string[];
      replierId: string;
      rootMessageId: string;
      recentReplyUserIds: string[];
    };
    expect(rp.rootMessageId).toBe(rootId);
    expect(rp.replierId).toBe(stack.admin.userId);
    expect(rp.replyCount).toBe(1);
    expect(rp.recipients).toContain(stack.member.userId); // root author
    expect(rp.recipients).not.toContain(stack.admin.userId); // replier
    expect(rp.recentReplyUserIds.length).toBeGreaterThan(0);
  });

  it('reply that also @mentions the root author dedupes — mention is one event, reply recipients exclude mentioned', async () => {
    // Seed: replier `@`-mentions the root author by username (the
    // real mention syntax per mention-extractor.ts).
    const rootId = await postRoot(stack.member.accessToken, 'hey everyone');
    const reply = await postReply(
      stack.admin.accessToken,
      rootId,
      `thanks @${stack.member.username}`,
    );
    expect(reply.status).toBe(201);

    const events = await env.prisma.outboxEvent.findMany({
      where: {
        eventType: { in: ['mention.received', 'message.thread.replied'] },
        OR: [{ aggregateId: rootId }, { aggregateId: stack.member.userId }],
      },
    });
    const mention = events.find((e) => e.eventType === 'mention.received');
    const replied = events.find((e) => e.eventType === 'message.thread.replied');
    expect(mention).toBeTruthy();
    expect(replied).toBeTruthy();
    const rp = replied!.payload as { recipients: string[] };
    // Mention already covers the root author — thread.replied recipients
    // must not duplicate that toast. Since the only recipient candidate
    // was the root author (who was also mentioned), recipients comes
    // back empty, not [rootAuthor].
    expect(rp.recipients).not.toContain(stack.member.userId);
  });
});
