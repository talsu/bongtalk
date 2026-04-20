/**
 * Task-014-B: message list DTO grows a thread summary on root messages.
 *   - replyCount is the COUNT of live (non-deleted) replies.
 *   - lastRepliedAt is the MAX(createdAt) over live replies.
 *   - recentReplyUserIds is the 3 most recent distinct authors.
 *   - replies themselves DO NOT appear in the channel list (roots only).
 *   - EXPLAIN check: the list + aggregate runs without a seq scan.
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
  const rl = await env.redis.keys('rl:*');
  if (rl.length > 0) await env.redis.del(...rl);
});

async function postRoot(token: string, content = 'root'): Promise<string> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content });
  return r.body.message.id;
}
async function postReply(token: string, parentMessageId: string, content: string): Promise<void> {
  await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content, parentMessageId })
    .expect(201);
}

describe('GET /channels/:chid/messages with thread summary (task-014-B)', () => {
  it('list returns roots only, with replyCount + lastRepliedAt + recentReplyUserIds', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    const rootB = await postRoot(stack.admin.accessToken, 'B');
    // 2 replies on A (member → admin), 0 on B.
    await postReply(stack.admin.accessToken, rootA, 'A-r1');
    await postReply(stack.owner.accessToken, rootA, 'A-r2');

    const r = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(r.status).toBe(200);
    // Replies ARE NOT in the list.
    const ids = r.body.items.map((m: { id: string }) => m.id);
    expect(ids).toHaveLength(2); // rootA + rootB only
    expect(ids).toEqual(expect.arrayContaining([rootA, rootB]));

    const rowA = r.body.items.find((m: { id: string }) => m.id === rootA);
    expect(rowA.thread.replyCount).toBe(2);
    expect(rowA.thread.lastRepliedAt).not.toBeNull();
    expect(rowA.thread.recentReplyUserIds).toEqual(
      expect.arrayContaining([stack.admin.userId, stack.owner.userId]),
    );

    const rowB = r.body.items.find((m: { id: string }) => m.id === rootB);
    // Zero-reply roots get thread=null (aggregate had no row for that rootId).
    expect(rowB.thread).toBeNull();
  });

  it('soft-deleted replies do not count in replyCount', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    await postReply(stack.admin.accessToken, rootA, 'alive');
    // Post a reply then soft-delete it via the normal DELETE route.
    const delTarget = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.admin.accessToken))
      .send({ content: 'doomed', parentMessageId: rootA });
    await request(env.baseUrl)
      .delete(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${delTarget.body.message.id}`,
      )
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    const r = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const rowA = r.body.items.find((m: { id: string }) => m.id === rootA);
    // Only the alive reply counts.
    expect(rowA.thread.replyCount).toBe(1);
  });

  it('EXPLAIN: roots-only list uses the partial index, not a seq scan', async () => {
    // Seed enough rows so the planner has a real choice.
    for (let i = 0; i < 20; i++) {
      const rid = await postRoot(stack.member.accessToken, `root ${i}`);
      await postReply(stack.admin.accessToken, rid, `r-${i}-a`);
    }
    const rows = await env.prisma.$queryRawUnsafe<Array<Record<string, string>>>(
      `
      EXPLAIN
      SELECT id FROM "Message"
       WHERE "channelId" = $1::uuid
         AND "parentMessageId" IS NULL
         AND "deletedAt" IS NULL
       ORDER BY "createdAt" DESC, id DESC
       LIMIT 50
    `,
      stack.channelId,
    );
    const plan = rows.map((r) => Object.values(r)[0]).join('\n');
    // The partial index `Message_channel_roots_idx` is the expected path.
    // If some future change regresses to a seq scan the assertion fires.
    expect(plan).not.toMatch(/Seq Scan on "Message"/i);
  });
});
