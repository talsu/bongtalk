import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * S102 (FR-DM rate-limit · carryover): DM 채널 생성/관리 mutation 엔드포인트의
 * per-user sliding-window 한도 회귀. 친구 게이트가 1차 방어이고 이 한도는 burst
 * 스팸 defense-in-depth 다(GlobalDmController). 대표로 createOrGet(POST /me/dms)
 * 을 검증한다 — createGroupDm/addParticipants 는 동일 RateLimitService.enforce
 * 패턴을 쓴다.
 *
 * createOrGet 은 같은 pair 에 대해 idempotent(기존 채널 반환)지만 호출마다 한도
 * 카운터를 소비하므로, DM_CREATE_MAX(60)회 성공 후 61번째는 RATE_LIMITED(429)다.
 * fresh signup 유저라 한도 키가 격리된다(다른 spec 과 비간섭).
 */
describe('S102 DM rate-limit (int)', () => {
  let env: DmIntEnv;
  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    env = await setupDmIntEnv();
    alice = await signup(env.baseUrl, 's102a');
    bob = await signup(env.baseUrl, 's102b');
    await makeFriends(env.baseUrl, alice, bob);
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  }, 60_000);

  it('createOrGet 은 DM_CREATE_MAX(60) 초과 시 429 RATE_LIMITED', async () => {
    const MAX = 60;
    const statuses: number[] = [];
    // MAX 회는 성공(idempotent → 같은 채널), MAX+1 번째는 한도 초과.
    for (let i = 0; i < MAX + 1; i++) {
      const res = await request(env.baseUrl)
        .post('/me/dms')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: bob.userId });
      statuses.push(res.status);
    }
    // 첫 호출은 성공(201 created 또는 200/2xx).
    expect(statuses[0]).toBeLessThan(300);
    // 정확히 MAX 회 성공(2xx), 나머지(=1회)는 429.
    const ok = statuses.filter((s) => s < 300).length;
    const limited = statuses.filter((s) => s === 429).length;
    expect(ok).toBe(MAX);
    expect(limited).toBe(1);
    // 마지막(MAX+1 번째)이 429.
    expect(statuses[MAX]).toBe(429);
  }, 60_000);

  // 072 백로그 S-A: visibility/mute/leave/members 라우트도 동일 enforce 패턴으로 보호된다.
  // 대표로 setVisibility(DM_VISIBILITY_MAX=30)를 검증(나머지 3개는 동일 RateLimitService.enforce).
  it('setVisibility 는 DM_VISIBILITY_MAX(30) 초과 시 429 RATE_LIMITED', async () => {
    // create 카운터가 격리되도록 fresh actor 쌍을 쓴다(alice 는 위 테스트에서 소진).
    const carol = await signup(env.baseUrl, 's102c');
    const dave = await signup(env.baseUrl, 's102d');
    await makeFriends(env.baseUrl, carol, dave);
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set('Authorization', `Bearer ${carol.accessToken}`)
      .send({ userId: dave.userId });
    const channelId = (dm.body as { channelId: string }).channelId;
    expect(channelId).toBeTruthy();

    const MAX = 30;
    const statuses: number[] = [];
    for (let i = 0; i < MAX + 1; i++) {
      const res = await request(env.baseUrl)
        .patch(`/me/dms/${channelId}/visibility`)
        .set('Authorization', `Bearer ${carol.accessToken}`)
        .send({ visibility: i % 2 === 0 ? 'HIDDEN' : 'VISIBLE' });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s < 300).length).toBe(MAX);
    expect(statuses[MAX]).toBe(429);
  }, 60_000);
});
