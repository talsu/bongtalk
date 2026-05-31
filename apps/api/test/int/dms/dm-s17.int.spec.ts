import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FRIEND_UNBLOCKED } from '../../../src/friends/friends.service';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * S17 (D03) — DM visibleFrom 필터 + 차단 DM 차단/마스킹 + around 정합 회귀 spec.
 *
 *  - FR-DM-13: 이미 열린 1:1 DM 에 send 시점 BLOCKED 재검증 → 403(FRIEND_BLOCKED).
 *              양방향(내가 차단 / 상대가 차단) 모두 거부.
 *  - FR-DM-17: DM 메시지 list(before/after/around/initial)에 요청자 visibleFrom
 *              필터 적용 — `createdAt >= visibleFrom` 이전 메시지 제외.
 *  - FR-TH-19: around 의 contextBefore 도 visibleFrom 이전 메시지를 제외.
 *  - FR-DM-18: 그룹 DM 에서 차단한 사용자의 메시지를 placeholder 로 마스킹(삭제 아님).
 *  - FR-DM-19: 차단 해제 시 friend.unblocked outbox → user:unblocked fanout.
 */
describe('S17 DM visibleFrom/block/around (int)', () => {
  let env: DmIntEnv;

  beforeAll(async () => {
    env = await setupDmIntEnv();
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  }, 60_000);

  /** Open a 1:1 DM between two freshly-signed-up friends. */
  async function openDm(a: Actor, b: Actor): Promise<string> {
    await makeFriends(env.baseUrl, a, b);
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(a.accessToken))
      .send({ userId: b.userId });
    if (dm.status >= 400) throw new Error(`createDm: ${dm.status} ${dm.text}`);
    return dm.body.channelId as string;
  }

  async function sendDm(actor: Actor, channelId: string, content: string): Promise<string> {
    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(actor.accessToken))
      .send({ content });
    if (res.status >= 400) throw new Error(`sendDm: ${res.status} ${res.text}`);
    return res.body.message.id as string;
  }

  // ── FR-DM-17: visibleFrom 필터 (before / after / initial) ─────────────────
  it('FR-DM-17: visibleFrom 이후 메시지만 보인다 (initial + before)', async () => {
    const a = await signup(env.baseUrl, 's17va');
    const b = await signup(env.baseUrl, 's17vb');
    const channelId = await openDm(a, b);

    // 3 older messages, then bump a's visibleFrom past them, then 2 newer.
    const m1 = await sendDm(a, channelId, 'old-1');
    const m2 = await sendDm(b, channelId, 'old-2');
    const m3 = await sendDm(a, channelId, 'old-3');

    // Move a's visibleFrom to "after m3" — simulating a restored/hidden DM.
    const after = await env.prisma.message.findUnique({ where: { id: m3 } });
    await env.prisma.channelPermissionOverride.updateMany({
      where: { channelId, principalType: 'USER', principalId: a.userId },
      data: { visibleFrom: new Date(after!.createdAt.getTime() + 1) },
    });

    const m4 = await sendDm(b, channelId, 'new-4');
    const m5 = await sendDm(a, channelId, 'new-5');

    // a (filtered) sees only the 2 new messages.
    const aList = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(a.accessToken));
    expect(aList.status).toBe(200);
    const aIds = aList.body.items.map((i: { id: string }) => i.id);
    expect(aIds).toEqual(expect.arrayContaining([m4, m5]));
    expect(aIds).not.toContain(m1);
    expect(aIds).not.toContain(m2);
    expect(aIds).not.toContain(m3);

    // b (no visibleFrom bump) still sees all 5.
    const bList = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(b.accessToken));
    expect(bList.body.items).toHaveLength(5);

    // before paging for a stays inside the visible window.
    const aBefore = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .query({ before: aList.body.pageInfo.nextCursor, limit: 50 })
      .set(bearer(a.accessToken));
    expect(aBefore.status).toBe(200);
    const beforeIds = aBefore.body.items.map((i: { id: string }) => i.id);
    expect(beforeIds).not.toContain(m1);
    expect(beforeIds).not.toContain(m3);
  });

  // ── FR-TH-19: around 의 contextBefore 도 visibleFrom 이전 제외 ─────────────
  it('FR-TH-19: around 의 contextBefore 가 visibleFrom 이전 메시지를 제외한다', async () => {
    const a = await signup(env.baseUrl, 's17aa');
    const b = await signup(env.baseUrl, 's17ab');
    const channelId = await openDm(a, b);

    const m1 = await sendDm(a, channelId, 'ctx-old-1');
    const m2 = await sendDm(b, channelId, 'ctx-old-2');
    // anchor + later messages are visible; the two above are below visibleFrom.
    const anchor = await sendDm(a, channelId, 'ctx-anchor');
    const anchorRow = await env.prisma.message.findUnique({ where: { id: anchor } });

    // visibleFrom set BETWEEN m2 and anchor — so anchor is visible but m1/m2 are not.
    await env.prisma.channelPermissionOverride.updateMany({
      where: { channelId, principalType: 'USER', principalId: a.userId },
      data: { visibleFrom: new Date(anchorRow!.createdAt.getTime()) },
    });

    const m4 = await sendDm(b, channelId, 'ctx-new-4');

    const around = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .query({ around: anchor, limit: 10 })
      .set(bearer(a.accessToken));
    expect(around.status).toBe(200);
    const ids = around.body.items.map((i: { id: string }) => i.id);
    // anchor + newer visible; older context below visibleFrom excluded.
    expect(ids).toContain(anchor);
    expect(ids).toContain(m4);
    expect(ids).not.toContain(m1);
    expect(ids).not.toContain(m2);
  });

  // ── FR-DM-13: BLOCKED send 403 (양방향) ───────────────────────────────────
  it('FR-DM-13: 차단 후 1:1 DM send 는 403 FRIEND_BLOCKED (양방향)', async () => {
    const a = await signup(env.baseUrl, 's17ba');
    const b = await signup(env.baseUrl, 's17bb');
    const channelId = await openDm(a, b);

    // Pre-block: send works.
    await sendDm(a, channelId, 'pre-block');

    // a blocks b.
    const blk = await request(env.baseUrl)
      .post(`/me/friends/block/${b.userId}`)
      .set(bearer(a.accessToken));
    expect(blk.status).toBeLessThan(400);

    // blocker (a) cannot send.
    const aSend = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(a.accessToken))
      .send({ content: 'a after block' });
    expect(aSend.status).toBe(403);
    expect(aSend.body.errorCode).toBe('FRIEND_BLOCKED');

    // blocked party (b) cannot send either (other direction).
    const bSend = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(b.accessToken))
      .send({ content: 'b after block' });
    expect(bSend.status).toBe(403);
    expect(bSend.body.errorCode).toBe('FRIEND_BLOCKED');
  });

  // ── FR-DM-18: 그룹 DM 차단 메시지 마스킹 ──────────────────────────────────
  it('FR-DM-18: 그룹 DM 에서 차단한 사용자의 메시지는 placeholder 로 마스킹된다', async () => {
    const a = await signup(env.baseUrl, 's17ga');
    const b = await signup(env.baseUrl, 's17gb');
    const c = await signup(env.baseUrl, 's17gc');
    await makeFriends(env.baseUrl, a, b);
    await makeFriends(env.baseUrl, a, c);

    const grp = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(a.accessToken))
      .send({ memberIds: [b.userId, c.userId] });
    expect(grp.status).toBeLessThan(400);
    const channelId = grp.body.channelId as string;

    const bMsg = await sendDm(b, channelId, 'hello from b');
    const cMsg = await sendDm(c, channelId, 'hello from c');

    // a blocks b.
    await request(env.baseUrl).post(`/me/friends/block/${b.userId}`).set(bearer(a.accessToken));

    const list = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(a.accessToken));
    expect(list.status).toBe(200);
    const byId = new Map(
      list.body.items.map((i: { id: string; content: string | null }) => [i.id, i]),
    );
    // b's message masked (placeholder), c's intact, row order preserved.
    expect((byId.get(bMsg) as { content: string }).content).toBe('[차단된 사용자의 메시지]');
    expect((byId.get(cMsg) as { content: string }).content).toBe('hello from c');

    // c (not blocking anyone) sees b's message unmasked.
    const cList = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(c.accessToken));
    const cView = new Map(
      cList.body.items.map((i: { id: string; content: string | null }) => [i.id, i]),
    );
    expect((cView.get(bMsg) as { content: string }).content).toBe('hello from b');
  });

  // ── BLOCKER (read-path bypass): 스레드 응답에도 차단 마스킹 ───────────────
  it('BLOCKER: 그룹 DM 스레드 루트/답변에서 차단 author 의 본문이 마스킹된다', async () => {
    const a = await signup(env.baseUrl, 's17ta');
    const b = await signup(env.baseUrl, 's17tb');
    const c = await signup(env.baseUrl, 's17tc');
    await makeFriends(env.baseUrl, a, b);
    await makeFriends(env.baseUrl, a, c);

    const grp = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(a.accessToken))
      .send({ memberIds: [b.userId, c.userId] });
    expect(grp.status).toBeLessThan(400);
    const channelId = grp.body.channelId as string;

    // b posts a root, then b + c reply on the thread.
    const rootId = await sendDm(b, channelId, 'thread root from b');
    const bReply = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(b.accessToken))
      .send({ content: 'b reply with @mention', parentMessageId: rootId });
    expect(bReply.status).toBeLessThan(400);
    const bReplyId = bReply.body.message.id as string;
    const cReply = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(c.accessToken))
      .send({ content: 'c reply intact', parentMessageId: rootId });
    expect(cReply.status).toBeLessThan(400);
    const cReplyId = cReply.body.message.id as string;

    // a blocks b.
    await request(env.baseUrl).post(`/me/friends/block/${b.userId}`).set(bearer(a.accessToken));

    // a (blocker) reads the thread — b's root + b's reply masked, c's reply intact.
    const aThread = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread?limit=50`)
      .set(bearer(a.accessToken));
    expect(aThread.status).toBe(200);
    expect(aThread.body.root.content).toBe('[차단된 사용자의 메시지]');
    expect(aThread.body.root.contentRaw).toBe('[차단된 사용자의 메시지]');
    const replies = new Map(
      aThread.body.replies.map((r: { id: string; content: string | null }) => [r.id, r]),
    );
    expect((replies.get(bReplyId) as { content: string }).content).toBe('[차단된 사용자의 메시지]');
    expect((replies.get(cReplyId) as { content: string }).content).toBe('c reply intact');

    // c (no block) reads the same thread — b's content intact.
    const cThread = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread?limit=50`)
      .set(bearer(c.accessToken));
    expect(cThread.body.root.content).toBe('thread root from b');
  });

  // ── NIT 5: 마스킹된 메시지는 mentions 도 비운다 ───────────────────────────
  it('NIT: 마스킹된 메시지의 mentions 가 비워진다 (멘션 badge 비점등)', async () => {
    const a = await signup(env.baseUrl, 's17ma');
    const b = await signup(env.baseUrl, 's17mb');
    const c = await signup(env.baseUrl, 's17mc');
    await makeFriends(env.baseUrl, a, b);
    await makeFriends(env.baseUrl, a, c);

    const grp = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(a.accessToken))
      .send({ memberIds: [b.userId, c.userId] });
    const channelId = grp.body.channelId as string;

    const bMsgId = await sendDm(b, channelId, 'hey ping');
    // Seed mentions directly — the UUID-form ids won't go through the `@{cuid2}`
    // mrkdwn extractor, so we set the JSONB column to simulate a message that
    // mentions `a` + @everyone + @here (which would otherwise light a's badge).
    await env.prisma.message.update({
      where: { id: bMsgId },
      data: { mentions: { users: [a.userId], channels: [], everyone: true, here: true } },
    });

    await request(env.baseUrl).post(`/me/friends/block/${b.userId}`).set(bearer(a.accessToken));

    const list = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(a.accessToken));
    const masked = list.body.items.find((i: { id: string }) => i.id === bMsgId) as {
      content: string;
      mentions: { users: string[]; everyone: boolean; here: boolean };
    };
    expect(masked.content).toBe('[차단된 사용자의 메시지]');
    expect(masked.mentions.users).toEqual([]);
    expect(masked.mentions.everyone).toBe(false);
    expect(masked.mentions.here).toBe(false);
  });

  // ── MAJOR (edit bypasses send-block): 차단 후 1:1 DM 편집은 403 ────────────
  it('MAJOR: 차단 후 1:1 DM 편집(PATCH)은 403 FRIEND_BLOCKED (양방향)', async () => {
    const a = await signup(env.baseUrl, 's17ea');
    const b = await signup(env.baseUrl, 's17eb');
    const channelId = await openDm(a, b);

    // pre-block: a sends + can edit.
    const aMsgId = await sendDm(a, channelId, 'editable pre-block');
    const bMsgId = await sendDm(b, channelId, 'b editable pre-block');
    const preEdit = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/messages/${aMsgId}`)
      .set(bearer(a.accessToken))
      .send({ content: 'edited pre-block', expectedVersion: 0 });
    expect(preEdit.status).toBe(200);

    // a blocks b.
    await request(env.baseUrl).post(`/me/friends/block/${b.userId}`).set(bearer(a.accessToken));

    // blocker (a) cannot edit.
    const aEdit = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/messages/${aMsgId}`)
      .set(bearer(a.accessToken))
      .send({ content: 'edited after block', expectedVersion: 1 });
    expect(aEdit.status).toBe(403);
    expect(aEdit.body.errorCode).toBe('FRIEND_BLOCKED');

    // blocked party (b) cannot edit either (other direction).
    const bEdit = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/messages/${bMsgId}`)
      .set(bearer(b.accessToken))
      .send({ content: 'b edit after block', expectedVersion: 0 });
    expect(bEdit.status).toBe(403);
    expect(bEdit.body.errorCode).toBe('FRIEND_BLOCKED');
  });

  // ── NIT 4: around anchor visibleFrom 게이트 (info-leak oracle) ─────────────
  it('NIT: around anchor 가 visibleFrom 이전이면 404 (200 빈 윈도 oracle 제거)', async () => {
    const a = await signup(env.baseUrl, 's17na');
    const b = await signup(env.baseUrl, 's17nb');
    const channelId = await openDm(a, b);

    const oldAnchor = await sendDm(a, channelId, 'old anchor below visibleFrom');
    const oldRow = await env.prisma.message.findUnique({ where: { id: oldAnchor } });

    // bump a's visibleFrom past the old anchor.
    await env.prisma.channelPermissionOverride.updateMany({
      where: { channelId, principalType: 'USER', principalId: a.userId },
      data: { visibleFrom: new Date(oldRow!.createdAt.getTime() + 1) },
    });

    const visibleAnchor = await sendDm(b, channelId, 'visible anchor');

    // around an anchor BELOW visibleFrom → 404 (not 200 empty window).
    const belowRes = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .query({ around: oldAnchor, limit: 10 })
      .set(bearer(a.accessToken));
    expect(belowRes.status).toBe(404);
    expect(belowRes.body.errorCode).toBe('MESSAGE_NOT_FOUND');

    // around a VISIBLE anchor still works (200) — no regression.
    const okRes = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .query({ around: visibleAnchor, limit: 10 })
      .set(bearer(a.accessToken));
    expect(okRes.status).toBe(200);
    const ids = okRes.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(visibleAnchor);
    expect(ids).not.toContain(oldAnchor);

    // b (no visibleFrom bump) can still around the old anchor — non-blocker
    // regression guard.
    const bRes = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .query({ around: oldAnchor, limit: 10 })
      .set(bearer(b.accessToken));
    expect(bRes.status).toBe(200);
  });

  // ── FR-DM-19: user:unblocked emit ────────────────────────────────────────
  it('FR-DM-19: 차단 해제 시 friend.unblocked 가 blocker 룸으로 dispatch 된다', async () => {
    const a = await signup(env.baseUrl, 's17ua');
    const b = await signup(env.baseUrl, 's17ub');
    await makeFriends(env.baseUrl, a, b);

    // a blocks then unblocks b.
    await request(env.baseUrl).post(`/me/friends/block/${b.userId}`).set(bearer(a.accessToken));

    const emitter = env.app.get(EventEmitter2);
    const received: Array<Record<string, unknown>> = [];
    const handler = (env_: Record<string, unknown>) => received.push(env_);
    emitter.on(FRIEND_UNBLOCKED, handler);

    const unblk = await request(env.baseUrl)
      .delete(`/me/friends/block/${b.userId}`)
      .set(bearer(a.accessToken));
    expect(unblk.status).toBe(204);

    await env.dispatcher.drain();
    emitter.off(FRIEND_UNBLOCKED, handler);

    expect(received.length).toBeGreaterThanOrEqual(1);
    const ev = received[0];
    // outbox envelope spreads the payload: targetUserId = blocker (a),
    // unblockedUserId = the unblocked peer (b).
    expect(ev.targetUserId).toBe(a.userId);
    expect(ev.unblockedUserId).toBe(b.userId);
  });
});
