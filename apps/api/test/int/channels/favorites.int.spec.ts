/**
 * S43 (D02 / FR-CH-15) — 채널 즐겨찾기 integration (실DB / Testcontainers).
 *
 * 검증(S05 교훈 — 마이그레이션 실DB 적용 + CRUD + position + unique):
 *   - 마이그레이션 적용 후 POST /favorite 가 행을 만들고 GET /me/favorites 가
 *     position asc 로 반환한다(추가 멱등성 포함).
 *   - 재정렬 PATCH /favorite/position(beforeId/afterId)가 fractional position 을
 *     주입해 목록 순서를 바꾼다.
 *   - DELETE /favorite 가 해제하고 목록에서 사라진다.
 *   - (userId, channelId) unique — 같은 채널 중복 추가가 행을 늘리지 않는다.
 *   - 비가시(비공개) 채널 즐겨찾기는 ChannelAccessGuard 로 차단(CHANNEL_NOT_VISIBLE).
 *
 * helpers.setupChIntEnv 가 `prisma migrate deploy` 로 신규 마이그레이션을 실제
 * PG16 에 적용하므로, 본 스펙이 도는 것 자체가 마이그레이션 적용 검증을 겸한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ChIntEnv, ORIGIN, bearer, seedWorkspaceWithRoles, setupChIntEnv } from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
  seed = await seedWorkspaceWithRoles(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(name: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(seed.admin.accessToken))
    .send({ name, type: 'TEXT' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('FR-CH-15 채널 즐겨찾기 (실DB)', () => {
  it('추가 → 목록(position asc) → 재정렬 → 해제 + (userId,channelId) unique', async () => {
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;
    const a = await createChannel(`fav-a-${Date.now().toString(36)}`);
    const b = await createChannel(`fav-b-${Date.now().toString(36)}`);
    const c = await createChannel(`fav-c-${Date.now().toString(36)}`);

    // 추가 (a, b, c 순) — 각 200
    for (const id of [a, b, c]) {
      const r = await request(env.baseUrl)
        .post(`/workspaces/${ws}/channels/${id}/favorite`)
        .set('origin', ORIGIN)
        .set(bearer(tok));
      expect(r.status).toBe(200);
      expect(r.body.channelId).toBe(id);
    }

    // 목록은 position asc → 추가 순서(말단 append)대로 a,b,c
    const list1 = await request(env.baseUrl)
      .get('/me/favorites')
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(list1.status).toBe(200);
    expect(list1.body.items.map((x: { channelId: string }) => x.channelId)).toEqual([a, b, c]);

    // 중복 추가는 멱등 — 행 수 불변(unique 보장)
    const dup = await request(env.baseUrl)
      .post(`/workspaces/${ws}/channels/${a}/favorite`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(dup.status).toBe(200);
    const rowCount = await env.prisma.userChannelFavorite.count({
      where: { userId: seed.member.userId },
    });
    expect(rowCount).toBe(3);

    // 재정렬: c 를 a 앞으로(afterId 없음·beforeId=a) → c,a,b
    const mv = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/channels/${c}/favorite/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ beforeId: a });
    expect(mv.status).toBe(200);

    const list2 = await request(env.baseUrl)
      .get('/me/favorites')
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(list2.body.items.map((x: { channelId: string }) => x.channelId)).toEqual([c, a, b]);
    // position 은 모두 distinct(단사성)
    const positions = list2.body.items.map((x: { position: string }) => x.position);
    expect(new Set(positions).size).toBe(positions.length);

    // 해제: a 제거 → c,b
    const del = await request(env.baseUrl)
      .delete(`/workspaces/${ws}/channels/${a}/favorite`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(del.status).toBe(204);
    const list3 = await request(env.baseUrl)
      .get('/me/favorites')
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(list3.body.items.map((x: { channelId: string }) => x.channelId)).toEqual([c, b]);
  }, 60_000);

  it('동시 병렬 추가는 멱등 — 둘 다 200·행 1개·500 없음(P2002 캐치)', async () => {
    // S43 review MAJOR: addFavorite 가 findUnique→create 라 동시 더블클릭 시
    // @@unique 위반(P2002)이 캐치되지 않으면 500(멱등 위반). 같은 (user,channel)
    // 에 두 요청을 병렬로 던져 둘 다 200·행 1개임을 확인한다.
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;
    const ch = await createChannel(`fav-par-${Date.now().toString(36)}`);

    const [r1, r2] = await Promise.all([
      request(env.baseUrl)
        .post(`/workspaces/${ws}/channels/${ch}/favorite`)
        .set('origin', ORIGIN)
        .set(bearer(tok)),
      request(env.baseUrl)
        .post(`/workspaces/${ws}/channels/${ch}/favorite`)
        .set('origin', ORIGIN)
        .set(bearer(tok)),
    ]);
    // 둘 다 멱등 성공(200). 어느 쪽도 500 이 아니어야 한다.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.channelId).toBe(ch);
    expect(r2.body.channelId).toBe(ch);

    const cnt = await env.prisma.userChannelFavorite.count({
      where: { userId: seed.member.userId, channelId: ch },
    });
    expect(cnt).toBe(1);
  }, 60_000);

  it('재정렬 anchor 가 즐겨찾기에 없으면 404(silent append 폴백 제거)', async () => {
    // S43 review MED: afterId/beforeId 가 제공됐는데 해당 anchor 가 사용자
    // 즐겨찾기에 없으면 무음 말단 append 대신 FAVORITE_NOT_FOUND(404).
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;
    const target = await createChannel(`fav-mvtgt-${Date.now().toString(36)}`);
    const orphan = await createChannel(`fav-mvorp-${Date.now().toString(36)}`);

    // target 만 즐겨찾기에 추가(orphan 은 채널이지만 즐겨찾기 아님 = stale anchor).
    const add = await request(env.baseUrl)
      .post(`/workspaces/${ws}/channels/${target}/favorite`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(add.status).toBe(200);

    // beforeId 가 즐겨찾기 아닌 채널 → 404
    const mvBefore = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/channels/${target}/favorite/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ beforeId: orphan });
    expect(mvBefore.status).toBe(404);
    expect(mvBefore.body.errorCode).toBe('FAVORITE_NOT_FOUND');

    // afterId 동일하게 404
    const mvAfter = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/channels/${target}/favorite/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ afterId: orphan });
    expect(mvAfter.status).toBe(404);
    expect(mvAfter.body.errorCode).toBe('FAVORITE_NOT_FOUND');
  }, 60_000);

  it('self-reference anchor(대상=anchor)는 VALIDATION_FAILED(400)', async () => {
    // S43 review LOW: 이동 대상 channelId 와 anchor 가 동일하면 position 조기소진
    // 방지를 위해 진입부에서 거부한다.
    const ws = seed.workspaceId;
    const tok = seed.member.accessToken;
    const self = await createChannel(`fav-self-${Date.now().toString(36)}`);
    const add = await request(env.baseUrl)
      .post(`/workspaces/${ws}/channels/${self}/favorite`)
      .set('origin', ORIGIN)
      .set(bearer(tok));
    expect(add.status).toBe(200);

    const mv = await request(env.baseUrl)
      .patch(`/workspaces/${ws}/channels/${self}/favorite/position`)
      .set('origin', ORIGIN)
      .set(bearer(tok))
      .send({ beforeId: self });
    expect(mv.status).toBe(400);
    expect(mv.body.errorCode).toBe('VALIDATION_FAILED');
  }, 60_000);

  it('비가시 비공개 채널 즐겨찾기는 ChannelAccessGuard 로 차단', async () => {
    const ws = seed.workspaceId;
    // owner 가 비공개 채널 생성 → member 는 비가시
    const priv = await request(env.baseUrl)
      .post(`/workspaces/${ws}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(seed.owner.accessToken))
      .send({ name: `fav-priv-${Date.now().toString(36)}`, type: 'TEXT', isPrivate: true });
    expect(priv.status).toBe(201);

    const r = await request(env.baseUrl)
      .post(`/workspaces/${ws}/channels/${priv.body.id}/favorite`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('CHANNEL_NOT_VISIBLE');
  }, 60_000);
});
