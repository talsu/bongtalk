import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  MsgIntEnv,
  ORIGIN,
  bearer,
  seedMessageStack,
  seedRawMessages,
  setupMsgIntEnv,
} from './helpers';

/**
 * S10 fix-forward (BLOCKER): `after`-방향 cursor 페이지네이션이 페이지 경계에서
 * 메시지를 잃지 않는지 실DB로 검증합니다.
 *
 * 버그: `list()` 가 `after` 방향에서 limit+1 행을 DESC 로 정렬 후 slice(0,limit)
 * 하여 *가장 오래된*(after 커서에 가장 가까운) 행을 매 페이지 떨어뜨렸습니다.
 * gap-fetch(웹 gapFetch.ts)는 `prevCursor`(가장 새 항목)로 after 를 전진시키므로
 * 떨어진 행이 다음 페이지에 다시 안 나와 영구 손실됩니다. >50 갭(= 한 페이지
 * 초과)에서 경계마다 1행씩 사라집니다.
 *
 * 이 스펙은 웹 gap-fetch 의 정확한 페이징 계약(after=prevCursor 전진, limit=50)을
 * 서버 REST 에 그대로 재현해 "경계 넘어 0 손실" 을 강제합니다.
 */
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
});

type ListBody = {
  items: Array<{ id: string }>;
  pageInfo: { hasMore: boolean; nextCursor: string | null; prevCursor: string | null };
};

async function list(params: string): Promise<ListBody> {
  const res = await request(env.baseUrl)
    .get(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages${params}`)
    .set('origin', ORIGIN)
    .set(bearer(stack.member.accessToken));
  expect(res.status).toBe(200);
  return res.body as ListBody;
}

/**
 * 웹 gap-fetch 와 동일한 페이징: `after` 커서부터 hasMore 가 끝날 때까지
 * `prevCursor`(가장 새 항목)로 전진. 모든 페이지의 id 를 순서대로 누적.
 */
async function gapFetchAll(initialAfter: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = initialAfter;
  let guard = 0;
  while (after !== null) {
    if (guard++ > 100) throw new Error('runaway pagination');
    const body: ListBody = await list(`?limit=${limit}&after=${after}`);
    for (const m of body.items) ids.push(m.id);
    if (!body.pageInfo.hasMore) break;
    const next = body.pageInfo.prevCursor;
    if (next === null || next === after) break;
    after = next;
  }
  return ids;
}

function cursorFor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

describe('Messages gap-fetch — after-direction boundary loss (BLOCKER)', () => {
  it('>50 메시지 갭을 limit=50 페이징해도 경계 넘어 0 손실', async () => {
    // 130개 메시지를 시드. ids[0]=가장 오래됨 ... ids[129]=가장 새것.
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 130,
    });
    // 클라가 마지막으로 본 메시지가 ids[4] 라고 가정 → after=ids[4] 부터의
    // 갭은 ids[5..129] = 125개(>50, 3페이지 분량).
    const anchor = await env.prisma.message.findUnique({ where: { id: ids[4] } });
    const after = cursorFor(anchor!.createdAt.toISOString(), anchor!.id);

    const collected = await gapFetchAll(after, 50);
    const expected = ids.slice(5); // 125개

    // 1) 중복 없음.
    expect(new Set(collected).size).toBe(collected.length);
    // 2) 정확히 125개(경계 손실이 있었다면 < 125).
    expect(collected.length).toBe(expected.length);
    // 3) 갭의 모든 id 가 빠짐없이 등장(경계의 가장 오래된 행 포함).
    const got = new Set(collected);
    for (const id of expected) {
      expect(got.has(id)).toBe(true);
    }
  });

  it('정확히 limit 경계(51개 갭)에서도 가장 오래된 행을 잃지 않음', async () => {
    // 회귀의 최소 재현: 갭이 limit(50)을 정확히 1개 초과 → 첫 페이지가 꽉 차
    // hasMore=true 가 되어 trim 분기가 발동하는 경계 케이스.
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 60,
    });
    // after=ids[8] → 갭 ids[9..59] = 51개.
    const anchor = await env.prisma.message.findUnique({ where: { id: ids[8] } });
    const after = cursorFor(anchor!.createdAt.toISOString(), anchor!.id);

    const collected = await gapFetchAll(after, 50);
    const expected = ids.slice(9); // 51개
    expect(collected.length).toBe(expected.length);
    // 경계에서 가장 오래된 행(ids[9], after 에 가장 가까움)이 반드시 포함.
    expect(collected).toContain(ids[9]);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('before 방향은 무회귀 — 여전히 newest N 을 DESC 로 반환', async () => {
    const { ids } = await seedRawMessages(env.prisma, {
      channelId: stack.channelId,
      authorId: stack.member.userId,
      count: 120,
    });
    // 초기 로드(newest 50) → before 로 2페이지 더, 누적 unique 가 모든 id 커버.
    const p1 = await list('?limit=50');
    const p2 = await list(`?limit=50&before=${p1.pageInfo.nextCursor}`);
    const p3 = await list(`?limit=50&before=${p2.pageInfo.nextCursor}`);
    const all = [...p1.items, ...p2.items, ...p3.items].map((m) => m.id);
    expect(new Set(all).size).toBe(all.length); // no dup
    expect(new Set(all).size).toBe(120);
    for (const id of ids) expect(all).toContain(id);
  });
});
