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

  // ── S33 (FR-TH-16) — 비정규화 카운터 정합 ───────────────────────────────
  it('replyCount/latestReplyAt are denormalized columns kept in sync (insert +1)', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    // 답글 INSERT 마다 루트의 비정규화 컬럼이 +1 / latestReplyAt 갱신.
    await postReply(stack.admin.accessToken, rootA, 'r1');
    let root = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    expect(root.replyCount).toBe(1);
    expect(root.latestReplyAt).not.toBeNull();
    const firstLatest = root.latestReplyAt!.getTime();

    await postReply(stack.owner.accessToken, rootA, 'r2');
    root = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    expect(root.replyCount).toBe(2);
    // 두 번째 답글의 createdAt 이 더 늦거나 같다(같은 가짜 시계라 >= ).
    expect(root.latestReplyAt!.getTime()).toBeGreaterThanOrEqual(firstLatest);
  });

  it('soft-deleting a reply decrements root replyCount via GREATEST(0, -1)', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    await postReply(stack.admin.accessToken, rootA, 'keep');
    const del = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.admin.accessToken))
      .send({ content: 'doomed', parentMessageId: rootA });
    let root = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    expect(root.replyCount).toBe(2);

    await request(env.baseUrl)
      .delete(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${del.body.message.id}`,
      )
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    root = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    // GREATEST(0, 2-1) = 1.
    expect(root.replyCount).toBe(1);
  });

  it('threadMeta read returns the denormalized columns directly (no aggregate drift)', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    await postReply(stack.admin.accessToken, rootA, 'r1');
    await postReply(stack.owner.accessToken, rootA, 'r2');

    const r = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const rowA = r.body.items.find((m: { id: string }) => m.id === rootA);
    const dbRoot = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    // 비정규화 컬럼과 응답 threadMeta 가 정확히 일치한다(집계 경로 제거 확인).
    expect(rowA.thread.replyCount).toBe(dbRoot.replyCount);
    expect(new Date(rowA.thread.lastRepliedAt).getTime()).toBe(dbRoot.latestReplyAt!.getTime());
  });

  it('replyParticipants is capped at 5 distinct authors', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    // 3명의 distinct author 로 6개 답글(중복 author 포함) — distinct 5 cap 검증은
    // 시드에 5명이 없으므로 distinct 수(여기선 3)와 cap(5) 둘 다 만족함을 확인한다.
    await postReply(stack.admin.accessToken, rootA, 'a1');
    await postReply(stack.owner.accessToken, rootA, 'o1');
    await postReply(stack.member.accessToken, rootA, 'm1');
    await postReply(stack.admin.accessToken, rootA, 'a2');

    const r = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const rowA = r.body.items.find((m: { id: string }) => m.id === rootA);
    expect(rowA.thread.recentReplyUserIds.length).toBeLessThanOrEqual(5);
    // distinct author 만(중복 admin 1회) → 3명.
    expect(new Set(rowA.thread.recentReplyUserIds).size).toBe(
      rowA.thread.recentReplyUserIds.length,
    );
  });

  // ── S33 (FR-MSG-09 carryover) — 답글 보유 deleted thread-root placeholder ──
  it('deleted thread-root with replies stays in the channel list as a placeholder', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'root with replies');
    await postReply(stack.admin.accessToken, rootA, 'a reply');
    const single = await postRoot(stack.member.accessToken, 'single deleted');

    // 루트(답글 보유) + 단독 메시지를 둘 다 삭제.
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${rootA}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${single}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    const r = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const ids = r.body.items.map((m: { id: string }) => m.id);
    // 답글 보유 deleted root 는 placeholder 로 유지, 단독 deleted 는 제거.
    expect(ids).toContain(rootA);
    expect(ids).not.toContain(single);
    const rowA = r.body.items.find((m: { id: string }) => m.id === rootA);
    expect(rowA.deleted).toBe(true);
    expect(rowA.content).toBeNull(); // 본문 마스킹
    expect(rowA.thread.replyCount).toBe(1); // reply bar 유지용 메타 보존
  });

  // ── S33 fix-forward (보안 BLOCKER) — 삭제 메시지 mentions/editedAt 마스킹 ──
  it('deleted thread-root placeholder masks mentions (no @-target userId leak)', async () => {
    // 멤버를 @멘션하는 루트를 작성 → 답글로 thread-root 로 만든 뒤 루트 삭제.
    // 삭제 placeholder 응답에 mentions.users(멘션 대상 userId)가 노출되면 안 된다.
    const r1 = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: `hello @${stack.admin.username} please look` })
      .expect(201);
    const rootA = r1.body.message.id as string;
    // 멘션이 실제로 추출됐는지 확인(전제 보장 — 없으면 마스킹 단언이 무의미).
    expect(r1.body.message.mentions.users).toContain(stack.admin.userId);

    await postReply(stack.owner.accessToken, rootA, 'a reply keeps it alive');
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${rootA}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    const r = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const rowA = r.body.items.find((m: { id: string }) => m.id === rootA);
    expect(rowA.deleted).toBe(true);
    expect(rowA.content).toBeNull();
    // 보안 BLOCKER: 삭제 메시지의 @멘션 대상 userId 가 새지 않아야 한다.
    expect(rowA.mentions.users).toEqual([]);
    expect(rowA.mentions.channels).toEqual([]);
    expect(rowA.mentions.everyone).toBe(false);
    expect(rowA.mentions.here).toBe(false);
    expect(rowA.mentions.channel).toBe(false);
  });

  it('deleted reply in the thread panel masks mentions + editedAt', async () => {
    // 루트 + 멘션 답글 작성 → 답글 편집(editedAt 세팅) → 답글 삭제. 스레드 패널
    // (GET /thread)이 삭제 답글을 placeholder 로 반환할 때 mentions/editedAt 비노출.
    const rootA = await postRoot(stack.member.accessToken, 'thread root');
    const replyRes = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.admin.accessToken))
      .send({ content: `ping @${stack.owner.username}`, parentMessageId: rootA })
      .expect(201);
    const replyId = replyRes.body.message.id as string;
    expect(replyRes.body.message.mentions.users).toContain(stack.owner.userId);

    // 편집으로 editedAt 을 세팅(낙관적 잠금 version=0 스냅샷).
    await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${replyId}`)
      .set(bearer(stack.admin.accessToken))
      .send({ content: `ping @${stack.owner.username} edited`, expectedVersion: 0 })
      .expect(200);
    // 삭제.
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${replyId}`)
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    // 스레드 답글 엔드포인트는 top-level `/messages/:id/thread` 다(ws/ch prefix 없음).
    const t = await request(env.baseUrl)
      .get(`/messages/${rootA}/thread`)
      .set(bearer(stack.member.accessToken))
      .expect(200);
    const delReply = t.body.replies.find((m: { id: string }) => m.id === replyId);
    expect(delReply.deleted).toBe(true);
    expect(delReply.content).toBeNull();
    // 보안 BLOCKER: 삭제 답글의 멘션 대상 + 편집 여부/시각 비노출.
    expect(delReply.mentions.users).toEqual([]);
    expect(delReply.edited).toBe(false);
    expect(delReply.editedAt).toBeNull();
  });

  // ── S33 fix-forward (MAJOR-1) — latestReplyAt GREATEST 동시성 monotonic ──
  it('a stale (older createdAt) reply never overwrites a newer latestReplyAt', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    await postReply(stack.admin.accessToken, rootA, 'r-newer');
    const afterNewer = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    const newerLatest = afterNewer.latestReplyAt!.getTime();

    // 더 과거 createdAt 의 답글을 직접 INSERT(동시 답글의 순서 뒤바뀜을 모사) —
    // send tx 의 GREATEST(COALESCE(latestReplyAt, -inf), createdAt) 가 과거값을
    // 거부해야 한다. raw INSERT + 동일 루트 카운터 UPDATE 를 재현한다.
    const staleAt = new Date(newerLatest - 60_000); // 1분 과거
    await env.prisma.message.create({
      data: {
        channelId: stack.channelId,
        authorId: stack.owner.userId,
        content: 'r-stale',
        contentPlain: 'r-stale',
        parentMessageId: rootA,
        createdAt: staleAt,
      },
    });
    await env.prisma.$executeRaw`
      UPDATE "Message"
         SET "replyCount" = "replyCount" + 1,
             "latestReplyAt" = GREATEST(
               COALESCE("latestReplyAt", '-infinity'::timestamptz),
               ${staleAt}
             )
       WHERE id = ${rootA}::uuid
         AND "deletedAt" IS NULL
    `;
    const after = await env.prisma.message.findUniqueOrThrow({ where: { id: rootA } });
    // 과거 createdAt 답글은 latestReplyAt 을 뒤로 감지 못한다(단조 증가만).
    expect(after.latestReplyAt!.getTime()).toBe(newerLatest);
    expect(after.replyCount).toBe(2);
  });

  it('EXPLAIN: roots-only list uses the partial index, not a seq scan', async () => {
    // Seed enough rows so the planner has a real choice.
    for (let i = 0; i < 20; i++) {
      const rid = await postRoot(stack.member.accessToken, `root ${i}`);
      await postReply(stack.admin.accessToken, rid, `r-${i}-a`);
    }
    // S33 fix-forward (MAJOR-3): prod rawList 가 실제로 발행하는 술어로 갱신한다.
    // 종전엔 `deletedAt IS NULL` 단독이었으나 S33 은 답글 보유 deleted thread-root
    // 를 placeholder 로 살리려 `("deletedAt" IS NULL OR "replyCount" > 0)` 를
    // 쓴다(FR-MSG-09 carryover). false-green 을 막고 OR 필터가 partial roots
    // index 위 Index Scan + bounded recheck 로 도는지 검증한다.
    const rows = await env.prisma.$queryRawUnsafe<Array<Record<string, string>>>(
      `
      EXPLAIN
      SELECT id FROM "Message"
       WHERE "channelId" = $1::uuid
         AND "parentMessageId" IS NULL
         AND ("deletedAt" IS NULL OR "replyCount" > 0)
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
