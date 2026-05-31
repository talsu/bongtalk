/**
 * S15 (D02) 통합 테스트 — FR-CH-08 / FR-CH-12 / FR-CH-13.
 *
 * 기존 channels.* 무회귀는 그대로 두고, 본 슬라이스의 신규 동작만 검증한다:
 *  - FR-CH-08 slowmode: 설정 후 연속 송신 429 + retryAfterMs / TTL 경과 후 허용 /
 *    BYPASS_SLOWMODE 보유자(ADMIN) 무제한 / slowmodeSeconds=0 무동작.
 *  - FR-CH-12 카테고리 soft-delete: 삭제 시 소속 채널 categoryId=NULL(동일 tx) +
 *    삭제 후 동명 재사용 + 목록 제외.
 *  - FR-CH-13 배치 재정렬: PATCH /channels/positions·/categories/positions 가
 *    1000 등간격으로 재정규화하고 position 이 단사(injective)·정렬 보존.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ChIntEnv, ORIGIN, setupChIntEnv, seedWorkspaceWithRoles, bearer } from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  seed = await seedWorkspaceWithRoles(env.baseUrl);
});

const rnd = () => Math.random().toString(36).slice(2, 8);

async function createChannel(token: string, body: Record<string, unknown>) {
  return request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

async function patchChannel(token: string, channelId: string, body: Record<string, unknown>) {
  return request(env.baseUrl)
    .patch(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

async function sendMessage(token: string, channelId: string, content: string) {
  return request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
}

async function createCategory(token: string, name: string) {
  return request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/categories`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ name });
}

describe('S15 FR-CH-08 — slowmode', () => {
  it('연속 송신은 429 CHANNEL_SLOWMODE_ACTIVE + retryAfterMs, TTL 경과 후 허용', async () => {
    const channelId = (await createChannel(seed.admin.accessToken, { name: `sm-${rnd()}` })).body
      .id as string;
    // slowmode 1초로 설정.
    const upd = await patchChannel(seed.admin.accessToken, channelId, { slowmodeSeconds: 1 });
    expect(upd.status).toBe(200);
    expect(upd.body.slowmodeSeconds).toBe(1);

    // BYPASS 미보유 member 의 첫 송신은 통과.
    const first = await sendMessage(seed.member.accessToken, channelId, 'hi-1');
    expect(first.status).toBe(201);

    // 즉시 두 번째 송신은 슬로우모드로 거부(429 + retryAfterMs + retry-after 헤더).
    const second = await sendMessage(seed.member.accessToken, channelId, 'hi-2');
    expect(second.status).toBe(429);
    expect(second.body.errorCode).toBe('CHANNEL_SLOWMODE_ACTIVE');
    expect(typeof second.body.retryAfterMs).toBe('number');
    expect(second.body.retryAfterMs).toBeGreaterThan(0);
    expect(second.headers['retry-after']).toBeDefined();

    // TTL(1초) 경과 후 다시 허용. Redis TTL 은 실시간이므로 실제로 대기한다.
    await new Promise((r) => setTimeout(r, 1200));
    const third = await sendMessage(seed.member.accessToken, channelId, 'hi-3');
    expect(third.status).toBe(201);
  }, 30_000);

  it('BYPASS_SLOWMODE 보유자(ADMIN baseline)는 무제한 연속 송신', async () => {
    const channelId = (await createChannel(seed.admin.accessToken, { name: `smb-${rnd()}` })).body
      .id as string;
    await patchChannel(seed.admin.accessToken, channelId, { slowmodeSeconds: 30 });

    // ADMIN 은 BYPASS_SLOWMODE baseline 보유 → 연속 송신 모두 통과.
    for (let i = 0; i < 3; i++) {
      const res = await sendMessage(seed.admin.accessToken, channelId, `admin-${i}`);
      expect(res.status).toBe(201);
    }
  }, 30_000);

  it('slowmodeSeconds=0 이면 게이트 무동작 (member 연속 송신 통과)', async () => {
    const channelId = (await createChannel(seed.admin.accessToken, { name: `sm0-${rnd()}` })).body
      .id as string;
    // 기본 slowmodeSeconds=0.
    for (let i = 0; i < 3; i++) {
      const res = await sendMessage(seed.member.accessToken, channelId, `m-${i}`);
      expect(res.status).toBe(201);
    }
  }, 30_000);
});

describe('S15 FR-CH-12 — category soft-delete', () => {
  it('삭제 시 소속 채널 categoryId=NULL(동일 tx) + 목록 제외 + 동명 재사용', async () => {
    const name = `cat-${rnd()}`;
    const catId = (await createCategory(seed.admin.accessToken, name)).body.id as string;
    // 채널을 카테고리에 배치.
    const chId = (
      await createChannel(seed.admin.accessToken, { name: `c-${rnd()}`, categoryId: catId })
    ).body.id as string;

    // 삭제(soft-delete).
    const del = await request(env.baseUrl)
      .delete(`/workspaces/${seed.workspaceId}/categories/${catId}`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken));
    expect(del.status).toBe(204);

    // DB: 카테고리는 deletedAt 찍힘(물리 삭제 아님), 채널 categoryId=NULL.
    const catRow = await env.prisma.category.findUnique({ where: { id: catId } });
    expect(catRow?.deletedAt).not.toBeNull();
    const chRow = await env.prisma.channel.findUnique({ where: { id: chId } });
    expect(chRow?.categoryId).toBeNull();

    // 채널 목록(API)에서 삭제된 카테고리는 제외, 채널은 uncategorized 로 노출.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken));
    expect(list.body.categories.find((c: { id: string }) => c.id === catId)).toBeUndefined();
    expect(list.body.uncategorized.find((c: { id: string }) => c.id === chId)).toBeDefined();

    // 동명 재사용: partial unique 덕분에 같은 이름으로 재생성 가능.
    const recreate = await createCategory(seed.admin.accessToken, name);
    expect(recreate.status).toBe(201);
    expect(recreate.body.id).not.toBe(catId);
  }, 30_000);
});

describe('S15 FR-CH-13 — batch reorder + renormalize', () => {
  it('PATCH /channels/positions 가 1000 등간격으로 재정규화하고 순서를 보존', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await createChannel(seed.admin.accessToken, { name: `r-${i}-${rnd()}` });
      ids.push(c.body.id as string);
    }
    // 역순으로 재정렬.
    const reversed = [...ids].reverse();
    const res = await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/channels/positions`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ items: reversed.map((id) => ({ id, categoryId: null })) });
    expect(res.status).toBe(200);

    // 재정규화 결과: position 이 1000 등간격이며, 요청한 역순을 보존한다.
    const rows = await env.prisma.channel.findMany({
      where: { workspaceId: seed.workspaceId, deletedAt: null, categoryId: null },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    const orderedIds = rows.map((r) => r.id);
    expect(orderedIds).toEqual(reversed);
    // position 단사성 + 1000 등간격(1000, 2000, ...).
    const positions = rows.map((r) => Number(r.position));
    expect(new Set(positions).size).toBe(positions.length);
    positions.forEach((p, i) => expect(p).toBe(1000 * (i + 1)));
  }, 30_000);

  it('PATCH /categories/positions 가 재정규화하고 순서를 보존', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await createCategory(seed.admin.accessToken, `cr-${i}-${rnd()}`);
      ids.push(c.body.id as string);
    }
    const reversed = [...ids].reverse();
    const res = await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/categories/positions`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ ids: reversed });
    expect(res.status).toBe(200);

    const rows = await env.prisma.category.findMany({
      where: { workspaceId: seed.workspaceId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    expect(rows.map((r) => r.id)).toEqual(reversed);
    rows.forEach((r, i) => expect(Number(r.position)).toBe(1000 * (i + 1)));
  }, 30_000);

  it('MEMBER 는 배치 재정렬 금지 (403)', async () => {
    const c = await createChannel(seed.admin.accessToken, { name: `rm-${rnd()}` });
    const res = await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/channels/positions`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ items: [{ id: c.body.id, categoryId: null }] });
    expect(res.status).toBe(403);
  }, 30_000);
});
