/**
 * S72 (D13 / FR-W16): /workspaces/discover Redis 5분 캐시 + joinMode 노출 통합 테스트.
 *
 * - 동일 쿼리 연속 호출: 첫 호출 X-Cache: MISS, 둘째 X-Cache: HIT.
 * - 디스커버리 노출 필드 변경(PATCH name) 후 캐시 무효화 → 다음 호출 MISS(버전 bump).
 * - 응답 아이템에 joinMode 포함(PUBLIC join 모드가 그대로 노출).
 *
 * 헬퍼 signupAsUser 는 emailVerified=true 로 마킹된다(S66 회귀 수정). 시간은 고정.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('/workspaces/discover — Redis cache + joinMode (FR-W16)', () => {
  it('serves MISS then HIT for an identical query, exposes joinMode, and invalidates on PATCH', async () => {
    const owner = await signupAsUser(env.baseUrl, 'dc');
    const stamp = Date.now().toString(36);
    const slug = `cache-${stamp}`;
    const created = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Cache Forge',
        slug,
        visibility: 'PUBLIC',
        category: 'PROGRAMMING',
        description: 'cache test workspace',
        joinMode: 'PUBLIC',
      });
    expect(created.status).toBe(201);
    const workspaceId = created.body.id as string;

    // A query string unique to this run so we don't collide with other specs'
    // cache entries (the version key is process-wide / Redis-wide).
    const queryUrl = `/workspaces/discover?q=Cache%20Forge&limit=20`;

    // 1) First call — MISS, populates cache, includes joinMode.
    const first = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    const firstItems = first.body.items as Array<{ slug: string; joinMode?: string }>;
    const mine = firstItems.find((i) => i.slug === slug);
    expect(mine).toBeDefined();
    expect(mine?.joinMode).toBe('PUBLIC');

    // 2) Second identical call — HIT.
    const second = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(second.status).toBe(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);

    // 3) PATCH a discovery-exposed field (name) → version bump invalidates all
    //    cached pages. The next identical query is a MISS again.
    const patched = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Cache Forge Renamed' });
    expect(patched.status).toBe(200);

    const third = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(third.status).toBe(200);
    expect(third.headers['x-cache']).toBe('MISS');
  });

  it('does not invalidate on a non-discovery field change (settings PATCH)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'dc2');
    const stamp = Date.now().toString(36);
    const slug = `nocache-${stamp}`;
    const created = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Settings Forge',
        slug,
        visibility: 'PUBLIC',
        category: 'PROGRAMMING',
        description: 'settings test workspace',
      });
    expect(created.status).toBe(201);
    const workspaceId = created.body.id as string;
    const queryUrl = `/workspaces/discover?q=Settings%20Forge&limit=20`;

    const first = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(first.headers['x-cache']).toBe('MISS');

    // Attachment-policy PATCH does not touch discovery exposure → no bump.
    const settings = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/settings`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxFileSizeBytes: 1048576 });
    expect(settings.status).toBe(200);

    const second = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(second.headers['x-cache']).toBe('HIT');
  });
});
