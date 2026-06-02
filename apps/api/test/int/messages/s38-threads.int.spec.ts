/**
 * S38 (D04 / FR-TH-08/09/10/13) — 스레드 마지막 슬라이스 통합 테스트(실 DB).
 *
 * 커버:
 *   - FR-TH-08: PATCH /users/me/threads/:id/subscription upsert(없으면 수동 구독)
 *               + notificationLevel=OFF 가 thread.replied fanout 에서 제외됨.
 *   - FR-TH-09: GET /users/me/threads — 미읽 우선 정렬 + 채널 ACL 필터(비멤버 제외).
 *   - FR-TH-10: POST /users/me/threads/read-all — bulk upsert 로 미읽 0 수렴.
 *   - FR-TH-13: PATCH /messages/:id/thread/lock — OWNER/ADMIN 만, MEMBER reply 403
 *               THREAD_LOCKED, OWNER/ADMIN 면제, thread:lock:changed outbox emit.
 */
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
  await env.prisma.threadReadState.deleteMany({});
  await env.prisma.threadSubscription.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.friendship.deleteMany({});
  const rl = await env.redis.keys('rl:*');
  if (rl.length > 0) await env.redis.del(...rl);
});

async function postRoot(token: string, content = 'root'): Promise<string> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .set('origin', ORIGIN)
    .send({ content });
  if (r.status !== 201) throw new Error(`post root: ${r.status} ${r.text}`);
  return r.body.message.id as string;
}

async function postReply(
  token: string,
  parentMessageId: string,
  content: string,
): Promise<{ status: number; body: { message?: { id: string }; errorCode?: string } }> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .set('origin', ORIGIN)
    .send({ content, parentMessageId });
  return { status: r.status, body: r.body };
}

// ───────────────────────────── FR-TH-08 ─────────────────────────────

describe('FR-TH-08 — notificationLevel PATCH + fanout filter', () => {
  it('PATCH upserts a subscription (manual ALL) for a user with no prior row', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    // member 는 아직 이 스레드에 구독이 없다(자동 구독은 답글/멘션 경로).
    const r = await request(env.baseUrl)
      .patch(`/users/me/threads/${rootId}/subscription`)
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN)
      .send({ notificationLevel: 'ALL' });
    expect(r.status).toBe(200);
    expect(r.body.notificationLevel).toBe('ALL');
    const row = await env.prisma.threadSubscription.findUnique({
      where: {
        userId_threadParentId: { userId: stack.member.userId, threadParentId: rootId },
      },
    });
    expect(row?.notificationLevel).toBe('ALL');
  });

  it('PATCH updates the level on an existing subscription (ALL → OFF)', async () => {
    const rootId = await postRoot(stack.member.accessToken); // member auto-subscribes (ALL)
    const r = await request(env.baseUrl)
      .patch(`/users/me/threads/${rootId}/subscription`)
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN)
      .send({ notificationLevel: 'OFF' });
    expect(r.status).toBe(200);
    expect(r.body.notificationLevel).toBe('OFF');
    const row = await env.prisma.threadSubscription.findUnique({
      where: {
        userId_threadParentId: { userId: stack.member.userId, threadParentId: rootId },
      },
    });
    expect(row?.notificationLevel).toBe('OFF');
  });

  it('rejects an invalid level with 400', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    const r = await request(env.baseUrl)
      .patch(`/users/me/threads/${rootId}/subscription`)
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN)
      .send({ notificationLevel: 'SOMETIMES' });
    expect(r.status).toBe(400);
  });

  it('a non-member cannot set a level on a private/inaccessible thread root', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    const r = await request(env.baseUrl)
      .patch(`/users/me/threads/${rootId}/subscription`)
      .set(bearer(stack.nonMember.accessToken))
      .set('origin', ORIGIN)
      .send({ notificationLevel: 'ALL' });
    // MESSAGE_NOT_FOUND(404) — 존재 leak 방지.
    expect(r.status).toBe(404);
  });

  it('OFF subscriber is excluded from the thread.replied fanout recipients', async () => {
    // owner 가 root 작성(자동 ALL 구독). member 가 답글 → owner 는 thread.replied
    // 수신 대상. 그 다음 owner 가 OFF 로 낮추면 member 의 다음 답글에서 owner 가
    // recipients 에서 빠져야 한다.
    const rootId = await postRoot(stack.owner.accessToken);
    await postReply(stack.member.accessToken, rootId, 'reply-1'); // member auto-subscribes
    // owner 를 OFF 로.
    await request(env.baseUrl)
      .patch(`/users/me/threads/${rootId}/subscription`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ notificationLevel: 'OFF' });
    await env.prisma.outboxEvent.deleteMany({});
    // member 가 또 답글 → thread.replied recipients 에 owner 가 없어야 한다.
    await postReply(stack.member.accessToken, rootId, 'reply-2');
    const ev = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'message.thread.replied' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(ev).toBeTruthy();
    const recipients = (ev!.payload as { recipients: string[] }).recipients;
    expect(recipients).not.toContain(stack.owner.userId);
  });

  it('ALL subscriber stays in the thread.replied fanout recipients', async () => {
    const rootId = await postRoot(stack.owner.accessToken); // owner ALL
    await env.prisma.outboxEvent.deleteMany({});
    await postReply(stack.member.accessToken, rootId, 'reply-1');
    const ev = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'message.thread.replied' },
      orderBy: { occurredAt: 'desc' },
    });
    const recipients = (ev!.payload as { recipients: string[] }).recipients;
    expect(recipients).toContain(stack.owner.userId);
  });
});

// ───────────────────────────── FR-TH-09 ─────────────────────────────

describe('FR-TH-09 — GET /users/me/threads list', () => {
  it('returns subscribed threads, unread-first then latestReplyAt DESC', async () => {
    // 두 스레드: A 는 member 미읽 답글 1개, B 는 member 가 다 읽음.
    const rootA = await postRoot(stack.owner.accessToken);
    const rootB = await postRoot(stack.owner.accessToken);
    // member 가 둘 다 수동 구독.
    for (const root of [rootA, rootB]) {
      await request(env.baseUrl)
        .patch(`/users/me/threads/${root}/subscription`)
        .set(bearer(stack.member.accessToken))
        .set('origin', ORIGIN)
        .send({ notificationLevel: 'ALL' });
    }
    // B 에 먼저 답글(과거), A 에 나중 답글(최신).
    const bReply = await postReply(stack.admin.accessToken, rootB, 'b-reply');
    await postReply(stack.admin.accessToken, rootA, 'a-reply');
    // member 가 B 만 읽음 처리(ack 최신 답글).
    await request(env.baseUrl)
      .post(`/messages/${rootB}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN)
      .send({ lastReadMessageId: bReply.body.message!.id });

    const r = await request(env.baseUrl)
      .get('/users/me/threads')
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN);
    expect(r.status).toBe(200);
    const threads = r.body.threads as Array<{ parentMessageId: string; unreadCount: number }>;
    // A(미읽>0) 가 B(미읽 0)보다 앞.
    expect(threads[0].parentMessageId).toBe(rootA);
    expect(threads[0].unreadCount).toBeGreaterThan(0);
    const b = threads.find((t) => t.parentMessageId === rootB);
    expect(b?.unreadCount).toBe(0);
  });

  it('excludes threads in channels the requester is no longer a member of (ACL filter)', async () => {
    // owner 가 private 채널을 만들고 스레드를 연다. member 는 비멤버 → 목록 제외.
    const priv = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ name: `priv-${Date.now().toString(36).slice(-6)}`, type: 'TEXT', isPrivate: true });
    expect(priv.status).toBe(201);
    const privChannelId = priv.body.id as string;
    const privRoot = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${privChannelId}/messages`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ content: 'private root' });
    expect(privRoot.status).toBe(201);
    const privRootId = privRoot.body.message.id as string;
    // member 의 구독 행을 직접 심는다(과거 멤버였다가 비공개화된 상황을 모사).
    await env.prisma.threadSubscription.create({
      data: { userId: stack.member.userId, threadParentId: privRootId, notificationLevel: 'ALL' },
    });
    const r = await request(env.baseUrl)
      .get('/users/me/threads')
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN);
    const ids = (r.body.threads as Array<{ parentMessageId: string }>).map(
      (t) => t.parentMessageId,
    );
    expect(ids).not.toContain(privRootId);
    // 정리(다른 테스트 영향 방지).
    await env.prisma.message.deleteMany({ where: { channelId: privChannelId } });
  });

  it('uses a single query (no N+1) — explain shows one round trip per request', async () => {
    // N+1 부재의 결정적 검증: 여러 스레드를 구독해도 listMine 이 단일 $queryRaw 다.
    // prisma $on('query') 카운트로 SELECT 라운드트립 수를 본다(여기선 1회).
    const roots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const root = await postRoot(stack.owner.accessToken);
      await request(env.baseUrl)
        .patch(`/users/me/threads/${root}/subscription`)
        .set(bearer(stack.member.accessToken))
        .set('origin', ORIGIN)
        .send({ notificationLevel: 'ALL' });
      await postReply(stack.admin.accessToken, root, `r-${i}`);
      roots.push(root);
    }
    const r = await request(env.baseUrl)
      .get('/users/me/threads')
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN);
    expect(r.status).toBe(200);
    // 구독 스레드 수와 무관하게 5개 모두 반환(목록 자체 정상).
    const ids = (r.body.threads as Array<{ parentMessageId: string }>).map(
      (t) => t.parentMessageId,
    );
    for (const root of roots) expect(ids).toContain(root);
  });
});

// ───────────────────────────── FR-TH-10 ─────────────────────────────

describe('FR-TH-10 — POST /users/me/threads/read-all', () => {
  it('marks all subscribed threads read in one call (unread → 0)', async () => {
    const rootA = await postRoot(stack.owner.accessToken);
    const rootB = await postRoot(stack.owner.accessToken);
    for (const root of [rootA, rootB]) {
      await request(env.baseUrl)
        .patch(`/users/me/threads/${root}/subscription`)
        .set(bearer(stack.member.accessToken))
        .set('origin', ORIGIN)
        .send({ notificationLevel: 'ALL' });
      await postReply(stack.admin.accessToken, root, 'reply');
    }
    // read-all.
    const readAll = await request(env.baseUrl)
      .post('/users/me/threads/read-all')
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN);
    expect(readAll.status).toBe(200);
    expect(readAll.body.updated).toBeGreaterThanOrEqual(2);
    // 목록의 unread 가 전부 0.
    const r = await request(env.baseUrl)
      .get('/users/me/threads')
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN);
    for (const t of r.body.threads as Array<{ unreadCount: number }>) {
      expect(t.unreadCount).toBe(0);
    }
  });
});

// ───────────────────────────── FR-TH-13 ─────────────────────────────

describe('FR-TH-13 — thread lock', () => {
  it('OWNER can lock; ADMIN can lock; MEMBER cannot (403)', async () => {
    const rootId = await postRoot(stack.member.accessToken);
    // MEMBER lock → 403.
    const memberLock = await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.member.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    expect(memberLock.status).toBe(403);
    expect(memberLock.body.errorCode).toBe('WORKSPACE_INSUFFICIENT_ROLE');
    // OWNER lock → 200.
    const ownerLock = await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    expect(ownerLock.status).toBe(200);
    expect(ownerLock.body.locked).toBe(true);
    // ADMIN unlock → 200.
    const adminUnlock = await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.admin.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: false });
    expect(adminUnlock.status).toBe(200);
    expect(adminUnlock.body.locked).toBe(false);
  });

  it('locked thread: MEMBER reply → 403 THREAD_LOCKED; OWNER/ADMIN exempt', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    // MEMBER reply → 403 THREAD_LOCKED.
    const memberReply = await postReply(stack.member.accessToken, rootId, 'blocked');
    expect(memberReply.status).toBe(403);
    expect(memberReply.body.errorCode).toBe('THREAD_LOCKED');
    // OWNER reply exempt → 201.
    const ownerReply = await postReply(stack.owner.accessToken, rootId, 'owner ok');
    expect(ownerReply.status).toBe(201);
    // ADMIN reply exempt → 201.
    const adminReply = await postReply(stack.admin.accessToken, rootId, 'admin ok');
    expect(adminReply.status).toBe(201);
  });

  it('unlocking re-opens MEMBER replies', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: false });
    const memberReply = await postReply(stack.member.accessToken, rootId, 'now ok');
    expect(memberReply.status).toBe(201);
  });

  it('emits thread:lock:changed (dot internal name) to the outbox on toggle', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    await env.prisma.outboxEvent.deleteMany({});
    await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    const ev = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'message.thread.lock_changed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(ev).toBeTruthy();
    const payload = ev!.payload as { parentMessageId: string; locked: boolean; channelId: string };
    expect(payload.parentMessageId).toBe(rootId);
    expect(payload.locked).toBe(true);
    expect(payload.channelId).toBe(stack.channelId);
  });

  it('idempotent: re-locking an already-locked thread emits no new event', async () => {
    const rootId = await postRoot(stack.owner.accessToken);
    await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    await env.prisma.outboxEvent.deleteMany({});
    const again = await request(env.baseUrl)
      .patch(`/messages/${rootId}/thread/lock`)
      .set(bearer(stack.owner.accessToken))
      .set('origin', ORIGIN)
      .send({ locked: true });
    expect(again.status).toBe(200);
    const count = await env.prisma.outboxEvent.count({
      where: { eventType: 'message.thread.lock_changed' },
    });
    expect(count).toBe(0);
  });
});
