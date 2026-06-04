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

  it('invalidates the cache when a new PUBLIC workspace is created (HIGH-2)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'dccreate');
    const stamp = Date.now().toString(36);
    // A category-scoped query that this run owns. We prime the cache, then
    // create a PUBLIC workspace in the same category and re-run the identical
    // query — it must MISS again (version bumped) and now include the new WS.
    // Before the HIGH-2 fix, create() did not invalidate, so the second call
    // would HIT and the new workspace would be invisible until TTL expiry.
    const queryUrl = `/workspaces/discover?category=GAMING&q=createbump-${stamp}&limit=20`;

    const first = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect((first.body.items as Array<{ slug: string }>).length).toBe(0);

    // Prime: a second identical call is a HIT (cache populated).
    const primed = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(primed.headers['x-cache']).toBe('HIT');

    const slug = `createbump-${stamp}`;
    const created = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        // The name must contain the exact `q` substring for the ILIKE match —
        // q is `createbump-${stamp}` (with the hyphen), so the name carries it
        // verbatim rather than a space-separated variant.
        name: `createbump-${stamp}`,
        slug,
        visibility: 'PUBLIC',
        category: 'GAMING',
        description: 'create-invalidate test workspace',
        joinMode: 'PUBLIC',
      });
    expect(created.status).toBe(201);

    // The identical query must now MISS (create() bumped the version) and the
    // freshly created PUBLIC workspace must appear.
    const after = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(after.status).toBe(200);
    expect(after.headers['x-cache']).toBe('MISS');
    const found = (after.body.items as Array<{ slug: string }>).find((i) => i.slug === slug);
    expect(found).toBeDefined();
  });

  it('does not invalidate the cache when a PRIVATE workspace is created', async () => {
    const owner = await signupAsUser(env.baseUrl, 'dcpriv');
    const stamp = Date.now().toString(36);
    // PRIVATE workspaces never appear in discover, so creating one must NOT
    // bump the version — an already-primed query stays a HIT.
    const queryUrl = `/workspaces/discover?category=GAMING&q=privnobump-${stamp}&limit=20`;

    const first = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(first.headers['x-cache']).toBe('MISS');

    const created = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: `privnobump ${stamp}`,
        slug: `privnobump-${stamp}`,
        visibility: 'PRIVATE',
      });
    expect(created.status).toBe(201);

    const second = await request(env.baseUrl)
      .get(queryUrl)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(second.headers['x-cache']).toBe('HIT');
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
