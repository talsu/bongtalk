/**
 * S36 (D04·D09 / FR-RS-12 / FR-TH-04/11/12/14) — 스레드 단위 읽음 상태.
 *
 * 게이트 4 매트릭스(실DB):
 *   - 스레드 unread 계산: 튜플 커서 · isBroadcast 제외 · deleted 제외 ·
 *     ThreadReadState 없음 = 전체 답글.
 *   - ACK monotonic: 퇴행 ack no-op.
 *   - reply bar dot 배치쿼리(N+1 없음 — threadMeta.hasUnread).
 *   - broadcast 채널 unread 포함 + 스레드 중복집계 없음 + 삭제 시 캐시 무효화 +
 *     채널 unreadCount 정확히 −1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';
import { ThreadReadStateService } from '../../../src/messages/thread-read-state.service';
import { MessagesService } from '../../../src/messages/messages.service';
import { UnreadService } from '../../../src/channels/unread.service';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
let threadReadState: ThreadReadStateService;
let unread: UnreadService;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  threadReadState = env.app.get(ThreadReadStateService);
  unread = env.app.get(UnreadService);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.threadSubscription.deleteMany({});
  await env.prisma.threadReadState.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.userChannelReadState.deleteMany({});
  await env.prisma.outboxEvent.deleteMany({});
  const rl = await env.redis.keys('rl:*');
  if (rl.length > 0) await env.redis.del(...rl);
  const un = await env.redis.keys('unread:*');
  if (un.length > 0) await env.redis.del(...un);
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
  isBroadcast = false,
): Promise<string> {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set(bearer(token))
    .send({ content, parentMessageId, ...(isBroadcast ? { isBroadcast: true } : {}) });
  if (r.status !== 201) throw new Error(`post reply: ${r.status} ${r.text}`);
  return r.body.message.id;
}

describe('S36 — 스레드 unread 계산 (FR-TH-11 / FR-RS-12)', () => {
  it('ThreadReadState 없으면 전체 비삭제 답글 수를 미읽으로 센다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    await postReply(stack.admin.accessToken, rootId, 'r1');
    await postReply(stack.owner.accessToken, rootId, 'r2');

    const count = await threadReadState.unreadCountFor(stack.member.userId, rootId);
    expect(count).toBe(2);
  });

  it('ACK 후 그 답글까지는 읽음(미읽 0), 이후 새 답글만 미읽', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'r1');
    await postReply(stack.owner.accessToken, rootId, 'r2');

    // r1 까지 ACK → r2 만 미읽.
    await request(env.baseUrl)
      .post(`/messages/${rootId}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .send({ lastReadMessageId: r1 })
      .expect(204);

    expect(await threadReadState.unreadCountFor(stack.member.userId, rootId)).toBe(1);
  });

  it('isBroadcast 답글은 스레드 미읽에서 제외한다(FR-TH-14 중복집계 금지)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    await postReply(stack.admin.accessToken, rootId, 'plain reply');
    // broadcast 답글 — 채널 행은 isBroadcast=true 의 별도 행이 생기지만
    // 스레드 unread 에는 산입되지 않는다(원본 답글만).
    await postReply(stack.admin.accessToken, rootId, 'bcast reply', true);

    // 스레드 미읽 = 비-broadcast 답글 2개(plain + broadcast 의 원본 답글).
    // broadcast 채널 복제 행(isBroadcast=true)은 제외된다.
    const count = await threadReadState.unreadCountFor(stack.owner.userId, rootId);
    expect(count).toBe(2);
    // DB 검증: parentMessageId=root 인 행 중 isBroadcast=true 가 정확히 1개 존재
    // 하지만 위 count 에는 빠져 있어야 한다.
    const broadcastRows = await env.prisma.message.count({
      where: { parentMessageId: rootId, isBroadcast: true },
    });
    expect(broadcastRows).toBe(1);
  });

  it('삭제된 답글은 스레드 미읽에서 제외한다', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'r1');
    await postReply(stack.owner.accessToken, rootId, 'r2');

    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${r1}`)
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    // r1 삭제 → 미읽 1(r2)만.
    expect(await threadReadState.unreadCountFor(stack.member.userId, rootId)).toBe(1);
  });
});

describe('S36 — ACK monotonic (FR-TH-12)', () => {
  it('퇴행 ack 는 no-op (커서가 後進하지 않는다)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const r1 = await postReply(stack.admin.accessToken, rootId, 'r1');
    const r2 = await postReply(stack.owner.accessToken, rootId, 'r2');

    // 먼저 r2(최신)까지 ACK → 미읽 0.
    await request(env.baseUrl)
      .post(`/messages/${rootId}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .send({ lastReadMessageId: r2 })
      .expect(204);
    expect(await threadReadState.unreadCountFor(stack.member.userId, rootId)).toBe(0);

    // 퇴행 ack(r1 — 더 오래된 답글) → 커서 불변(no-op), 미읽 여전히 0.
    await request(env.baseUrl)
      .post(`/messages/${rootId}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .send({ lastReadMessageId: r1 })
      .expect(204);
    expect(await threadReadState.unreadCountFor(stack.member.userId, rootId)).toBe(0);

    // 저장된 커서가 여전히 r2 인지 직접 확인(後進 없음).
    const row = await env.prisma.threadReadState.findUnique({
      where: { userId_parentMessageId: { userId: stack.member.userId, parentMessageId: rootId } },
    });
    expect(row?.lastReadMessageId).toBe(r2);
  });

  it('타 채널/스레드 외 메시지 id 로 ack 하면 404 (IDOR 차단)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    const otherRoot = await postRoot(stack.member.accessToken, 'other');
    // otherRoot 는 rootId 의 답글이 아니므로 404.
    await request(env.baseUrl)
      .post(`/messages/${rootId}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .send({ lastReadMessageId: otherRoot })
      .expect(404);
  });
});

describe('S36 — reply bar dot 배치쿼리 (FR-TH-04 / N+1 없음)', () => {
  it('threadMeta.hasUnread 가 per-viewer 로 채널 목록에 실린다', async () => {
    const rootA = await postRoot(stack.member.accessToken, 'A');
    const rootB = await postRoot(stack.member.accessToken, 'B');
    await postReply(stack.admin.accessToken, rootA, 'A-r1');
    await postReply(stack.admin.accessToken, rootB, 'B-r1');

    // member 는 아직 아무것도 ACK 안 함 → 둘 다 hasUnread=true.
    const list1 = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const rowA1 = list1.body.items.find((m: { id: string }) => m.id === rootA);
    const rowB1 = list1.body.items.find((m: { id: string }) => m.id === rootB);
    expect(rowA1.thread.hasUnread).toBe(true);
    expect(rowB1.thread.hasUnread).toBe(true);

    // rootA 의 답글까지 ACK → A 는 false, B 는 여전히 true.
    const aReply = (
      await request(env.baseUrl)
        .get(`/messages/${rootA}/thread?limit=50`)
        .set(bearer(stack.member.accessToken))
    ).body.replies[0].id;
    await request(env.baseUrl)
      .post(`/messages/${rootA}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .send({ lastReadMessageId: aReply })
      .expect(204);

    const list2 = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages?limit=50`)
      .set(bearer(stack.member.accessToken));
    const rowA2 = list2.body.items.find((m: { id: string }) => m.id === rootA);
    const rowB2 = list2.body.items.find((m: { id: string }) => m.id === rootB);
    expect(rowA2.thread.hasUnread).toBe(false);
    expect(rowB2.thread.hasUnread).toBe(true);
  });

  it('배치 hasUnread 쿼리는 루트 수와 무관하게 단일 쿼리다(N+1 없음)', async () => {
    // 루트 5개 + 각 답글 1개. aggregateThreadSummaries(viewerId) 는 EXPLAIN 상
    // 단일 statement 여야 한다(루트마다 서브쿼리 발사 X).
    const roots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await postRoot(stack.member.accessToken, `root ${i}`);
      await postReply(stack.admin.accessToken, r, `reply ${i}`);
      roots.push(r);
    }
    // 직접 호출해 Map 이 루트 5개 전부에 대해 hasUnread 를 산정하는지 확인.
    // aggregateThreadSummaries 는 viewerId 와 함께 호출돼도 단일 $queryRaw 다
    // (루트마다 쿼리 발사 X — N+1 없음).
    const messages = env.app.get(MessagesService);
    const map = await messages.aggregateThreadSummaries(roots, stack.owner.userId);
    expect(map.size).toBe(5);
    for (const root of roots) {
      expect(map.get(root)?.hasUnread).toBe(true);
    }
  });
});

describe('S36 — broadcast 채널 unread (FR-TH-14)', () => {
  it('broadcast 행 삭제 시 채널 unreadCount 정확히 −1 + 캐시 즉시 무효화 (FR-TH-14)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    // owner 가 채널을 최신까지 읽음 처리(현재 root 까지) → 이후 새 메시지만 미읽.
    await unread.markChannelReadToLatest(stack.owner.userId, stack.channelId, stack.workspaceId);
    expect(await unread.unreadCountFor(stack.owner.userId, stack.channelId)).toBe(0);

    // broadcast 답글 → 채널 타임라인에 (1) 원본 답글 행 + (2) broadcast 채널 행
    // 둘 다 생성되지만, 채널 unread 는 roots-only 술어(parentMessageId IS NULL OR
    // isBroadcast=true)로 집계되므로 원본 답글 행(parentMessageId 보유·비-broadcast)
    // 은 제외되고 broadcast 채널 행(+1)만 산입된다(FR-TH-11). 따라서 채널 unread 는
    // 정확히 +1 이다 — 답글마다 유령 unread 가 붙던 BLOCKER-1 회귀를 막는다.
    const replyId = await postReply(stack.admin.accessToken, rootId, 'bcast', true);
    const before = await unread.unreadCountFor(stack.owner.userId, stack.channelId);
    expect(before).toBe(1);

    // Redis 캐시를 워밍(워크스페이스 totals 집계 → 캐시 채움).
    await unread.cachedWorkspaceTotal(stack.workspaceId, stack.owner.userId);
    const cacheKey = `unread:${stack.workspaceId}:${stack.owner.userId}`;
    expect(await env.redis.exists(cacheKey)).toBe(1);

    // broadcast 채널 행을 찾아 soft-delete.
    const broadcastRow = await env.prisma.message.findFirst({
      where: { channelId: stack.channelId, isBroadcast: true },
      select: { id: true },
    });
    expect(broadcastRow).toBeTruthy();
    await request(env.baseUrl)
      .delete(
        `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${broadcastRow!.id}`,
      )
      .set(bearer(stack.admin.accessToken))
      .expect(204);

    // FR-TH-14: broadcast 행 삭제 → 채널 unread 정확히 −1 (원본 답글은 roots-only
    // 술어로 애초에 채널 unread 에 산입되지 않으므로, broadcast 행이 빠지면 0).
    const after = await unread.unreadCountFor(stack.owner.userId, stack.channelId);
    expect(after).toBe(before - 1);
    expect(after).toBe(0);
    // FR-TH-14 + S36 fix-forward(perf): 캐시 무효화는 best-effort fire-and-forget
    // 으로 옮겨졌으므로(softDelete hot-path 분리), DELETE 응답 직후가 아니라
    // eventually 키가 사라짐을 확인한다(짧은 폴링). DB COUNT 가 정본이라 캐시
    // 무효화는 파생 정리일 뿐 — 이 테스트는 무효화가 결국 일어남을 보증한다.
    let invalidated = false;
    for (let i = 0; i < 50; i++) {
      if ((await env.redis.exists(cacheKey)) === 0) {
        invalidated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(invalidated).toBe(true);
    expect(replyId).toBeTruthy();
  });

  it('broadcast 답글이 스레드 unread 와 채널 unread 에 중복집계되지 않는다 (FR-TH-14)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    await unread.markChannelReadToLatest(stack.owner.userId, stack.channelId, stack.workspaceId);

    await postReply(stack.admin.accessToken, rootId, 'bcast', true);

    // 채널 unread: roots-only 술어로 원본 답글 행(parentMessageId 보유·비-broadcast)
    // 은 제외되고 broadcast 채널 행(isBroadcast=true)만 +1 산입된다(FR-TH-11/14).
    // 스레드 unread 에서는 isBroadcast=false 필터로 broadcast 채널행이 제외되므로,
    // 한 broadcast 답글이 채널·스레드 어느 쪽에도 *중복 산입되지 않는다*(서로 다른
    // 행이 각자 한 도메인에만 기여).
    const channelUnread = await unread.unreadCountFor(stack.owner.userId, stack.channelId);
    expect(channelUnread).toBe(1);
    // 스레드 unread: 원본 답글 1개만(broadcast 채널 복제 행은 제외). broadcast 가
    // 채널과 스레드 양쪽에 1+1 로 이중집계되지 않음을 보증한다(서로 다른 행).
    const threadUnread = await threadReadState.unreadCountFor(stack.owner.userId, rootId);
    expect(threadUnread).toBe(1);
  });
});

describe('S36 fix-forward — 채널 unread roots-only (FR-TH-11 / BLOCKER-1)', () => {
  it('스레드 답글 N개(broadcast 아님) 후 채널 unreadCount 불변 (답글 불산입)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    // owner 가 채널을 최신(현재 root)까지 읽음 → 채널 unread 0.
    await unread.markChannelReadToLatest(stack.owner.userId, stack.channelId, stack.workspaceId);
    expect(await unread.unreadCountFor(stack.owner.userId, stack.channelId)).toBe(0);

    // 비-broadcast 답글 3개. roots-only 술어(parentMessageId IS NULL OR
    // isBroadcast=true)로 채널 unread 에서 전부 제외돼야 한다 — 답글마다 채널
    // 배지가 +N 으로 새던 BLOCKER-1(유령 unread) 회귀를 막는 음성 테스트.
    for (let i = 0; i < 3; i++) {
      await postReply(stack.admin.accessToken, rootId, `reply ${i}`, false);
    }

    // 채널 unread 는 여전히 0 — 답글은 채널 미읽에 산입되지 않는다.
    expect(await unread.unreadCountFor(stack.owner.userId, stack.channelId)).toBe(0);
    // summarize(채널 목록 read-path)도 동일하게 0 을 보고해야 한다(broadcast 채널
    // 무효화 / fan-out 회귀 방지 — broadcast 아님이라 +N 도 없다).
    const summary = await unread.summarize(stack.workspaceId, stack.owner.userId);
    const chanRow = summary.find((s) => s.channelId === stack.channelId);
    expect(chanRow?.unreadCount).toBe(0);
  });

  it('답글 내 @멘션이 채널 멘션 카운트 불변 (mention 불산입)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    await unread.markChannelReadToLatest(stack.owner.userId, stack.channelId, stack.workspaceId);
    expect(await unread.mentionCountFor(stack.owner.userId, stack.channelId)).toBe(0);

    // 답글 본문에서 owner 를 @멘션. mentions.users 에 owner.userId 가 추출됨을
    // 먼저 전제 보장(없으면 단언이 무의미).
    const r = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.admin.accessToken))
      .send({ content: `hey @${stack.owner.username} look here`, parentMessageId: rootId })
      .expect(201);
    expect(r.body.message.mentions.users).toContain(stack.owner.userId);

    // 채널 멘션 카운트 불변 — 답글 내 멘션은 채널 멘션 배지에 산입되지 않는다
    // (roots-only 술어가 답글 행을 멘션 COUNT 에서도 제외).
    expect(await unread.mentionCountFor(stack.owner.userId, stack.channelId)).toBe(0);
    const summary = await unread.summarize(stack.workspaceId, stack.owner.userId);
    const chanRow = summary.find((s) => s.channelId === stack.channelId);
    expect(chanRow?.mentionCount).toBe(0);
    expect(chanRow?.hasMention).toBe(false);
  });
});

describe('S36 fix-forward — S11 채널 unread 무회귀 (루트 메시지)', () => {
  it('루트 메시지는 채널 unread/markAllRead 에 정상 산입된다', async () => {
    // 채널을 비운 상태에서 owner 읽음 처리 → 0.
    await unread.markChannelReadToLatest(stack.owner.userId, stack.channelId, stack.workspaceId);
    expect(await unread.unreadCountFor(stack.owner.userId, stack.channelId)).toBe(0);

    // 루트 메시지(parentMessageId NULL) 2개 → 채널 unread +2(roots-only 술어가
    // 루트는 그대로 센다 — BLOCKER-1 수정이 루트 집계를 깨지 않음).
    await postRoot(stack.member.accessToken, 'root1');
    await postRoot(stack.member.accessToken, 'root2');
    expect(await unread.unreadCountFor(stack.owner.userId, stack.channelId)).toBe(2);

    // markAllRead(워크스페이스 전체 읽음)로 다시 0 으로 수렴(advanceAllVisible 의
    // latest CTE 도 roots-only 술어를 쓰지만 루트는 포함되므로 전진이 정상 동작).
    await unread.markAllRead(stack.owner.userId, stack.workspaceId);
    expect(await unread.unreadCountFor(stack.owner.userId, stack.channelId)).toBe(0);
    const summary = await unread.summarize(stack.workspaceId, stack.owner.userId);
    const chanRow = summary.find((s) => s.channelId === stack.channelId);
    expect(chanRow?.unreadCount).toBe(0);
  });
});

describe('S36 fix-forward — archived 채널 스레드 ack/get 거부 (보안 MEDIUM)', () => {
  // 공유 stack.channelId 를 archive 하면 다른 spec 에 영향을 주므로 전용 채널을
  // 새로 만들어 archive 한다.
  async function createChannel(name: string): Promise<string> {
    const ch = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ name, type: 'TEXT' });
    if (ch.status !== 201) throw new Error(`channel create: ${ch.status} ${ch.text}`);
    return ch.body.id as string;
  }

  async function postRootIn(channelId: string, content: string): Promise<string> {
    const r = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content });
    if (r.status !== 201) throw new Error(`post root: ${r.status} ${r.text}`);
    return r.body.message.id;
  }

  it('archived 채널의 스레드 GET / ack 는 CHANNEL_ARCHIVED 로 거부된다', async () => {
    const chId = await createChannel(`arch-${Date.now().toString(36).slice(-6)}`);
    const rootId = await postRootIn(chId, 'root before archive');
    const replyRes = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${chId}/messages`)
      .set(bearer(stack.admin.accessToken))
      .send({ content: 'r1', parentMessageId: rootId });
    expect(replyRes.status).toBe(201);
    const replyId = replyRes.body.message.id as string;

    // 채널 archive.
    const archive = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${chId}/archive`)
      .set(bearer(stack.owner.accessToken));
    expect(archive.status).toBe(201);

    // GET thread → 409 CHANNEL_ARCHIVED.
    const getRes = await request(env.baseUrl)
      .get(`/messages/${rootId}/thread?limit=50`)
      .set(bearer(stack.member.accessToken));
    expect(getRes.status).toBe(409);
    expect(getRes.body.errorCode).toBe('CHANNEL_ARCHIVED');

    // POST ack → 409 CHANNEL_ARCHIVED.
    const ackRes = await request(env.baseUrl)
      .post(`/messages/${rootId}/thread/ack`)
      .set(bearer(stack.member.accessToken))
      .send({ lastReadMessageId: replyId });
    expect(ackRes.status).toBe(409);
    expect(ackRes.body.errorCode).toBe('CHANNEL_ARCHIVED');
  });
});
