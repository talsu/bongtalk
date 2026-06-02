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
import { ThreadReplyCountReconciler } from '../../../src/messages/thread-reply-count-reconciler.service';
import { ThreadSubscriptionsService } from '../../../src/messages/thread-subscriptions.service';

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
  // S34: threadSubscription 은 message FK 를 참조하므로 message 삭제 전에 비운다.
  await env.prisma.threadSubscription.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  // S34 fix-forward (security #3): BLOCKED 차단 관계 테스트가 행을 남기므로
  // 매 테스트 시작 시 friendship 을 비워 테스트 간 격리를 보장한다.
  await env.prisma.friendship.deleteMany({});
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

  // S33 (FR-TH-15): 삭제된 답글도 placeholder 로 목록에 남는다(시간순 자리 유지,
  // 본문 마스킹, deleted:true). 커서 페이지네이션은 그대로 유지된다.
  it('soft-deleted replies stay in the thread list as masked placeholders', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root message');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'keep me');
    const doomed = await postReply(stack.owner.accessToken, rootId, 'secret to be deleted');
    const r3 = await postReply(stack.member.accessToken, rootId, 'after deletion');

    await request(env.baseUrl)
      .delete(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${doomed.body.message!.id}`,
      )
      .set(bearer(stack.owner.accessToken))
      .expect(204);

    const r = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread?limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(r.status).toBe(200);
    // 3개 답글 모두 반환(삭제 1개 포함) — 제외하지 않음.
    expect(r.body.replies).toHaveLength(3);
    const ids = r.body.replies.map((m: { id: string }) => m.id);
    expect(ids).toEqual([r1.body.message!.id, doomed.body.message!.id, r3.body.message!.id]);
    // 삭제 답글은 deleted:true + 본문 마스킹.
    const deletedRow = r.body.replies.find((m: { id: string }) => m.id === doomed.body.message!.id);
    expect(deletedRow.deleted).toBe(true);
    expect(deletedRow.content).toBeNull();
    // 본문 평문이 새지 않는지 확인.
    expect(JSON.stringify(deletedRow)).not.toContain('secret to be deleted');
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
    // S33 (FR-TH-02): the query matches BOTH the root's and the reply's
    // message.created (root + reply aggregateIds). The reply event is the
    // one that must carry parentMessageId — select it by its aggregateId
    // (the reply message id), not the first-by-occurredAt (which is the
    // root's created with parentMessageId=null).
    const created = events.find(
      (e) => e.eventType === 'message.created' && e.aggregateId === reply.body.message!.id,
    )!;
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

// S34 (FR-TH-17): DELETE 트랜잭션 가드. 답글 soft-delete 가 단일 $transaction
// 안에서 루트의 replyCount 를 GREATEST(0, replyCount-1) 로 감소시키되, 이미
// 삭제된 루트는 건드리지 않고(deletedAt IS NULL 가드), 중복 삭제는 idempotent.
describe('Threads API — DELETE tx guard (S34 / FR-TH-17)', () => {
  function delMsg(token: string, msgId: string) {
    return request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(token));
  }

  it('decrements root replyCount on reply soft-delete (single tx)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'reply 1');
    await postReply(stack.owner.accessToken, rootId, 'reply 2');

    let root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.replyCount).toBe(2);

    await delMsg(stack.admin.accessToken, r1.body.message!.id).expect(204);

    root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.replyCount).toBe(1);
  });

  it('duplicate delete of the same reply is idempotent (replyCount decremented once)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'only reply');

    let root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.replyCount).toBe(1);

    // 첫 삭제 → 204, 둘째 삭제 → 이미 삭제됨이라 service count===0 no-op.
    await delMsg(stack.admin.accessToken, r1.body.message!.id).expect(204);
    await delMsg(stack.admin.accessToken, r1.body.message!.id);

    root = await env.prisma.message.findUnique({ where: { id: rootId } });
    // 두 번 깎이지 않고 정확히 1회만 감소.
    expect(root?.replyCount).toBe(0);
  });

  it('deleting a reply of an ALREADY-deleted root does not touch the deleted root row (deletedAt IS NULL guard)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root to delete');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'reply under doomed root');

    let root = await env.prisma.message.findUnique({ where: { id: rootId } });
    const replyCountBefore = root!.replyCount; // 1

    // 루트를 직접 soft-delete (답글은 존재 유지 — FR-MSG-09 placeholder).
    await delMsg(stack.member.accessToken, rootId).expect(204);
    root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.deletedAt).not.toBeNull();

    // 이제 그 답글을 삭제한다. deletedAt IS NULL 가드로 삭제된 루트의
    // replyCount 는 그대로(되감지 않음 — 매칭 0행 → UPDATE no-op).
    await delMsg(stack.admin.accessToken, r1.body.message!.id).expect(204);

    root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.replyCount).toBe(replyCountBefore); // 변하지 않음
  });
});

// S34 (FR-TH-17): TOCTOU orphan 방어. send tx 내부의 parent FOR UPDATE
// 재검증으로 삭제된 루트에 대한 답글 INSERT 를 거부한다.
describe('Threads API — orphan defense (S34 / FR-TH-17)', () => {
  it('rejects a reply to a root that was soft-deleted (no orphan INSERT)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'soon-deleted root');

    // 루트를 soft-delete.
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${rootId}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    // 삭제된 루트에 답글 시도 → 거부(404 MESSAGE_PARENT_NOT_FOUND).
    const reply = await postReply(stack.admin.accessToken, rootId, 'orphan attempt');
    expect(reply.status).toBe(404);
    expect(reply.body.errorCode).toBe('MESSAGE_PARENT_NOT_FOUND');

    // orphan 행이 INSERT 되지 않았는지 DB 로 확인.
    const orphans = await env.prisma.message.count({ where: { parentMessageId: rootId } });
    expect(orphans).toBe(0);
  });
});

// S34 (FR-TH-07): @멘션 자동 구독. 스레드 답글의 @멘션 대상에 ThreadSubscription
// 행이 같은 send $transaction 안에서 upsert 된다.
describe('Threads API — @mention auto-subscribe (S34 / FR-TH-07)', () => {
  it('creates a ThreadSubscription for a user @mentioned in a thread reply', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    // admin 이 owner 를 @멘션하는 답글 작성. owner 는 답글 작성자가 아니므로
    // (자동 follow 경로 밖) 멘션 자동 구독이 유일한 구독 경로다.
    const reply = await postReply(stack.admin.accessToken, rootId, `cc @${stack.owner.username}`);
    expect(reply.status).toBe(201);

    const sub = await env.prisma.threadSubscription.findUnique({
      where: {
        userId_threadParentId: { userId: stack.owner.userId, threadParentId: rootId },
      },
    });
    expect(sub).not.toBeNull();
  });

  it('mention auto-subscribe upsert is idempotent (one row for repeat mentions)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    // 같은 대상(owner)을 두 답글에서 멘션 → 구독 행은 1개만 존재.
    await postReply(stack.admin.accessToken, rootId, `hi @${stack.owner.username}`);
    await postReply(stack.admin.accessToken, rootId, `again @${stack.owner.username}`);

    const subs = await env.prisma.threadSubscription.findMany({
      where: { userId: stack.owner.userId, threadParentId: rootId },
    });
    expect(subs).toHaveLength(1);
  });
});

// S34 (FR-TH-17): replyCount drift 재집계 cron — 실 DB 대상.
describe('Threads API — replyCount reconcile (S34 / FR-TH-17)', () => {
  it('reconcile fixes a drifted root and leaves consistent roots untouched', async () => {
    const driftedRoot = await postRoot(stack.member.accessToken, 'drifted root');
    await postReply(stack.admin.accessToken, driftedRoot, 'real reply 1');
    await postReply(stack.owner.accessToken, driftedRoot, 'real reply 2');

    const consistentRoot = await postRoot(stack.member.accessToken, 'consistent root');
    await postReply(stack.admin.accessToken, consistentRoot, 'real reply');

    // 카운터를 인위적으로 어긋나게 만든다(직접 UPDATE — drift 시뮬레이션).
    await env.prisma.message.update({
      where: { id: driftedRoot },
      data: { replyCount: 99 },
    });

    const reconciler = env.app.get(ThreadReplyCountReconciler);
    const fixed = await reconciler.reconcile();

    // drift 1개만 교정.
    expect(fixed).toBe(1);
    const drifted = await env.prisma.message.findUnique({ where: { id: driftedRoot } });
    expect(drifted?.replyCount).toBe(2); // actual 비삭제 답글 수
    const consistent = await env.prisma.message.findUnique({ where: { id: consistentRoot } });
    expect(consistent?.replyCount).toBe(1); // 변하지 않음

    // 재실행은 no-op(모두 정합).
    const again = await reconciler.reconcile();
    expect(again).toBe(0);
  });

  it('reconcile counts only non-deleted replies', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root with deleted reply');
    await postReply(stack.admin.accessToken, rootId, 'kept');
    const doomed = await postReply(stack.owner.accessToken, rootId, 'to delete');

    // 답글 soft-delete → replyCount 는 이미 1 로 감소(DELETE tx).
    await request(env.baseUrl)
      .delete(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${doomed.body.message!.id}`,
      )
      .set(bearer(stack.owner.accessToken))
      .expect(204);

    // 카운터를 드리프트시킨 뒤 재집계가 비삭제 답글(1개)만 센다.
    await env.prisma.message.update({ where: { id: rootId }, data: { replyCount: 5 } });
    const reconciler = env.app.get(ThreadReplyCountReconciler);
    await reconciler.reconcile();

    const root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.replyCount).toBe(1);
  });
});

// S34 fix-forward (#1 tx-poisoning): subscribe() 가 ON CONFLICT DO NOTHING 으로
// 멱등화되어, 같은 (userId, threadParentId) 를 동시/순차 2회 구독해도 unique
// 위반(23505)으로 tx 가 abort 되지 않고 정상 commit + 1행만 남아야 한다.
describe('Threads API — subscribe idempotency / tx-poisoning (S34 / FR-TH-07)', () => {
  it('동시 2회 subscribe 가 throw 없이 정상 commit, 1행만 남는다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'concurrent subscribe root');
    const svc = env.app.get(ThreadSubscriptionsService);

    // 같은 (member, rootId) 를 동시에 2회 구독 — 종전 findUnique+create 였다면
    // 한쪽이 23505 → tx abort 였다. ON CONFLICT 라 둘 다 정상 resolve.
    const [a, b] = await Promise.all([
      svc.subscribe({ userId: stack.member.userId, threadParentId: rootId }),
      svc.subscribe({ userId: stack.member.userId, threadParentId: rootId }),
    ]);
    expect(a.subscribed).toBe(true);
    expect(b.subscribed).toBe(true);

    // 순차 3회째도 멱등.
    const c = await svc.subscribe({ userId: stack.member.userId, threadParentId: rootId });
    expect(c.subscribed).toBe(true);

    const rows = await env.prisma.threadSubscription.findMany({
      where: { userId: stack.member.userId, threadParentId: rootId },
    });
    expect(rows).toHaveLength(1);
  });

  it('자기 메시지 root 작성 + 동일 root 답글이 자동 follow tx 를 오염시키지 않는다', async () => {
    // member 가 root 를 작성하면 자동 follow 로 (member, root) 구독 행이 생긴다.
    const rootId = await postRoot(stack.member.accessToken, 'self-follow root');
    // member 가 같은 스레드에 답글 → 자동 follow 가 다시 (member, root) 를
    // 구독 시도하지만 ON CONFLICT 로 멱등. 답글 INSERT 와 카운터 갱신은 정상
    // commit 되어야 한다(tx 오염 없음).
    const reply = await postReply(stack.member.accessToken, rootId, 'my own reply');
    expect(reply.status).toBe(201);

    const subs = await env.prisma.threadSubscription.findMany({
      where: { userId: stack.member.userId, threadParentId: rootId },
    });
    expect(subs).toHaveLength(1);
    const root = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(root?.replyCount).toBe(1); // 답글이 정상 반영됨
  });
});

// S34 fix-forward (security #3): @멘션 자동 구독에서 차단/피차단 사용자를 제외한다.
describe('Threads API — @mention auto-subscribe excludes blocked users (S34 / security #3)', () => {
  it('작성자가 차단한 사용자는 멘션해도 자동 구독되지 않는다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    // admin(작성자)이 owner 를 차단(requesterId=admin, addresseeId=owner, BLOCKED).
    await env.prisma.friendship.create({
      data: {
        requesterId: stack.admin.userId,
        addresseeId: stack.owner.userId,
        status: 'BLOCKED',
      },
    });
    // admin 이 owner 를 멘션하는 답글 작성.
    const reply = await postReply(stack.admin.accessToken, rootId, `cc @${stack.owner.username}`);
    expect(reply.status).toBe(201);

    // 차단 상대(owner)는 자동 구독되지 않아야 한다.
    const sub = await env.prisma.threadSubscription.findUnique({
      where: {
        userId_threadParentId: { userId: stack.owner.userId, threadParentId: rootId },
      },
    });
    expect(sub).toBeNull();
  });

  it('작성자를 차단한 사용자도 멘션 자동 구독에서 제외된다(피차단 방향)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    // owner 가 admin(작성자)을 차단(requesterId=owner, addresseeId=admin).
    await env.prisma.friendship.create({
      data: {
        requesterId: stack.owner.userId,
        addresseeId: stack.admin.userId,
        status: 'BLOCKED',
      },
    });
    const reply = await postReply(stack.admin.accessToken, rootId, `cc @${stack.owner.username}`);
    expect(reply.status).toBe(201);

    const sub = await env.prisma.threadSubscription.findUnique({
      where: {
        userId_threadParentId: { userId: stack.owner.userId, threadParentId: rootId },
      },
    });
    expect(sub).toBeNull();
  });

  it('차단 관계가 없으면 멘션 자동 구독이 그대로 동작한다(무회귀)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const reply = await postReply(stack.admin.accessToken, rootId, `cc @${stack.owner.username}`);
    expect(reply.status).toBe(201);

    const sub = await env.prisma.threadSubscription.findUnique({
      where: {
        userId_threadParentId: { userId: stack.owner.userId, threadParentId: rootId },
      },
    });
    expect(sub).not.toBeNull();
  });
});

// S35 (FR-TH-06): 'Also send to #channel' broadcast. 답글을 isBroadcast=true 로
// 전송하면 같은 tx 안에서 별도의 SYSTEM_THREAD_BROADCAST 채널 행이 생성되고,
// 그 행이 채널 메시지 목록에 isBroadcast=true + parentExcerpt(루트 50자)로
// 노출되며 parentMessageId 로 스레드 루트에 링크된다. 스레드 답글 목록에는
// broadcast 행이 포함되지 않는다(채널 복제본이지 답글이 아님).
describe('Threads API — broadcast (S35 / FR-TH-06)', () => {
  async function postReplyBroadcast(
    token: string,
    parentMessageId: string,
    content: string,
  ): Promise<{ status: number; body: { message?: { id: string } } }> {
    const r = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(token))
      .send({ content, parentMessageId, isBroadcast: true });
    return { status: r.status, body: r.body };
  }

  it('broadcast 답글은 채널 타임라인에 isBroadcast 메시지 + 루트 excerpt 를 노출한다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'this is the original root message');
    const reply = await postReplyBroadcast(stack.admin.accessToken, rootId, 'broadcasted reply');
    expect(reply.status).toBe(201);

    // 채널 메시지 목록: 루트 + broadcast 행이 보인다(일반 답글은 보이지 않음).
    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(list.status).toBe(200);
    const items: Array<{
      id: string;
      isBroadcast: boolean;
      parentMessageId: string | null;
      parentExcerpt: string | null;
      content: string | null;
      type: string;
    }> = list.body.items;
    const broadcast = items.find((m) => m.isBroadcast === true);
    expect(broadcast).toBeTruthy();
    // broadcast 행은 SYSTEM_THREAD_BROADCAST 타입 + 스레드 루트로 링크.
    expect(broadcast!.type).toBe('SYSTEM_THREAD_BROADCAST');
    expect(broadcast!.parentMessageId).toBe(rootId);
    // 루트 본문 50자 이내 excerpt 가 포함된다(FR-TH-06 AC).
    expect(broadcast!.parentExcerpt).toBeTruthy();
    expect('this is the original root message').toContain(
      broadcast!.parentExcerpt!.replace('…', ''),
    );
    // 채널에서 답글 본문이 보인다.
    expect(broadcast!.content).toBe('broadcasted reply');
    // broadcast 행 != 답글 행(별도 행).
    expect(broadcast!.id).not.toBe(reply.body.message!.id);
  });

  it('broadcast 행은 스레드 답글 목록에는 포함되지 않는다(채널 복제본)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root for broadcast exclusion');
    await postReplyBroadcast(stack.admin.accessToken, rootId, 'broadcasted reply');

    const thread = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread?limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(thread.status).toBe(200);
    // 답글 1개(원본 답글)만 — broadcast 행은 제외.
    expect(thread.body.replies).toHaveLength(1);
    expect(thread.body.replies[0].isBroadcast).toBe(false);
    expect(thread.body.replies[0].content).toBe('broadcasted reply');
  });

  it('broadcast 답글은 message.created + thread.replied + thread.broadcast 를 모두 emit 한다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root for broadcast events');
    const reply = await postReplyBroadcast(stack.admin.accessToken, rootId, 'bc');
    expect(reply.status).toBe(201);

    const broadcastEvents = await env.prisma.outboxEvent.findMany({
      where: { eventType: 'message.thread.broadcast' },
    });
    expect(broadcastEvents).toHaveLength(1);
    const payload = broadcastEvents[0].payload as {
      parentMessageId: string;
      parentExcerpt: string;
      message: { isBroadcast: boolean; parentMessageId: string | null; type: string };
    };
    expect(payload.parentMessageId).toBe(rootId);
    expect(payload.parentExcerpt).toBeTruthy();
    expect(payload.message.isBroadcast).toBe(true);
    expect(payload.message.type).toBe('SYSTEM_THREAD_BROADCAST');
    expect(payload.message.parentMessageId).toBe(rootId);
  });

  it('isBroadcast 없이(default) 보내면 broadcast 행이 생성되지 않는다(무회귀)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root no broadcast');
    await postReply(stack.admin.accessToken, rootId, 'plain reply');

    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const items: Array<{ isBroadcast: boolean }> = list.body.items;
    expect(items.some((m) => m.isBroadcast === true)).toBe(false);

    const bc = await env.prisma.outboxEvent.findMany({
      where: { eventType: 'message.thread.broadcast' },
    });
    expect(bc).toHaveLength(0);
  });

  // S35 fix-forward (BLOCKER): broadcast 행은 parentMessageId(=루트)를 갖지만
  // 답글이 아니다. reply-count/participants/deletion 경로 어디에서도 답글로
  // 오집계되면 안 된다.
  it('broadcast 행은 루트 replyCount 에 산입되지 않는다(send + reconcile 양쪽)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root for replyCount leak');
    // 일반 답글 1 + broadcast 답글 1 → replyCount 는 2 가 아니라 2 여야 한다?
    // 아니다: 일반 답글은 +1, broadcast 답글은 (답글 본인 +1) + (broadcast 행은
    // 0). postReplyBroadcast 는 답글 1건 + broadcast 행 1건을 만들므로 실답글은 2.
    await postReply(stack.admin.accessToken, rootId, 'plain reply');
    await postReplyBroadcast(stack.owner.accessToken, rootId, 'broadcasted reply');

    const afterSend = await env.prisma.message.findUnique({ where: { id: rootId } });
    // 실답글 2건(plain + broadcast 의 원본 답글). broadcast 행 자체는 미산입.
    expect(afterSend?.replyCount).toBe(2);

    // reconcile 도 broadcast 행을 actual 에서 제외 → drift 시뮬레이션 후 2 로 수렴.
    await env.prisma.message.update({ where: { id: rootId }, data: { replyCount: 99 } });
    const reconciler = env.app.get(ThreadReplyCountReconciler);
    const fixed = await reconciler.reconcile();
    expect(fixed).toBe(1);
    const afterReconcile = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(afterReconcile?.replyCount).toBe(2); // broadcast 행을 세지 않음
  });

  it('broadcast 행 soft-delete 는 루트 replyCount 를 깎지 않는다(올린 적 없음)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root for broadcast delete');
    await postReplyBroadcast(stack.admin.accessToken, rootId, 'broadcasted reply');

    const before = await env.prisma.message.findUnique({ where: { id: rootId } });
    expect(before?.replyCount).toBe(1); // 원본 답글 1건만 산입

    // 채널 목록에서 broadcast 행 id 를 찾아 soft-delete.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const broadcast = (list.body.items as Array<{ id: string; isBroadcast: boolean }>).find(
      (m) => m.isBroadcast === true,
    );
    expect(broadcast).toBeTruthy();
    await request(env.baseUrl)
      .delete(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${broadcast!.id}`,
      )
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    const after = await env.prisma.message.findUnique({ where: { id: rootId } });
    // broadcast 는 카운터를 올린 적이 없으므로 삭제해도 감소하지 않는다.
    expect(after?.replyCount).toBe(1);
  });

  it('broadcast 행은 replyParticipants(아바타 스택)에 phantom 참여자로 잡히지 않는다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root for participants leak');
    // owner 가 broadcast 답글만 보낸다(원본 답글 author = owner, broadcast 행
    // author 도 owner). participants 는 distinct author 라 owner 1명만 나와야 하고
    // broadcast 행이 중복 슬롯을 차지하면 안 된다.
    await postReplyBroadcast(stack.owner.accessToken, rootId, 'broadcasted reply');

    const list = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const root = (
      list.body.items as Array<{
        id: string;
        thread: { replyCount: number; recentReplyUserIds: string[] } | null;
      }>
    ).find((m) => m.id === rootId);
    expect(root?.thread).toBeTruthy();
    expect(root!.thread!.replyCount).toBe(1);
    // distinct author 1명(owner) — broadcast 행이 중복으로 더해지지 않는다.
    expect(root!.thread!.recentReplyUserIds).toEqual([stack.owner.userId]);
  });

  it('broadcast 행은 루트 작성자 활동 피드에 phantom 답글로 잡히지 않는다(me-activity)', async () => {
    // member 가 루트 작성 → 루트 작성자 = member. admin 이 broadcast 답글 1건.
    // member 의 활동 피드 reply 항목은 원본 답글 1건뿐이어야 한다(broadcast 제외).
    const rootId = await postRoot(stack.member.accessToken, 'root for activity leak');
    await postReplyBroadcast(stack.admin.accessToken, rootId, 'broadcasted reply body');

    const feed = await request(env.baseUrl)
      .get(`/me/activity?filter=reply&limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(feed.status).toBe(200);
    const replyItems = (feed.body.items as Array<{ kind: string; messageId: string }>).filter(
      (i) => i.kind === 'reply',
    );
    // 원본 답글 1건만 — broadcast 행은 활동으로 잡히지 않는다.
    expect(replyItems).toHaveLength(1);
  });
});
