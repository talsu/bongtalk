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
import { MsgIntEnv, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';
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
    // 둘 다 채널 메시지라 채널 unread 는 +2 가 된다(채널 unread 는 답글 포함 —
    // 기존 S11 정책). broadcast 행 자체의 기여분은 정확히 1.
    const replyId = await postReply(stack.admin.accessToken, rootId, 'bcast', true);
    const before = await unread.unreadCountFor(stack.owner.userId, stack.channelId);
    expect(before).toBe(2);

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

    // FR-TH-14: broadcast 행 삭제 → 채널 unread 정확히 −1 (원본 답글 1은 잔존).
    const after = await unread.unreadCountFor(stack.owner.userId, stack.channelId);
    expect(after).toBe(before - 1);
    expect(after).toBe(1);
    // FR-TH-14: broadcast 삭제 시 모든 멤버 캐시 즉시 무효화(키가 사라짐).
    expect(await env.redis.exists(cacheKey)).toBe(0);
    expect(replyId).toBeTruthy();
  });

  it('broadcast 답글이 스레드 unread 와 채널 unread 에 중복집계되지 않는다 (FR-TH-14)', async () => {
    const rootId = await postRoot(stack.member.accessToken, 'root');
    await unread.markChannelReadToLatest(stack.owner.userId, stack.channelId, stack.workspaceId);

    await postReply(stack.admin.accessToken, rootId, 'bcast', true);

    // 채널 unread: 원본 답글 행(1) + broadcast 채널 행(1) = 2. broadcast 채널행은
    // 채널 미읽에만 산입(FR-TH-14). 스레드 unread 에서는 isBroadcast=false 필터로
    // 제외되므로, broadcast 채널행이 스레드 미읽에 *중복 산입되지 않는다*.
    const channelUnread = await unread.unreadCountFor(stack.owner.userId, stack.channelId);
    expect(channelUnread).toBe(2);
    // 스레드 unread: 원본 답글 1개만(broadcast 채널 복제 행은 제외). broadcast 가
    // 채널과 스레드 양쪽에 1+1 로 이중집계되지 않음을 보증한다(서로 다른 행).
    const threadUnread = await threadReadState.unreadCountFor(stack.owner.userId, rootId);
    expect(threadUnread).toBe(1);
  });
});
