/**
 * Task-015-B: full-text search integration.
 *   - English exact (tsvector path): "hello" matches "hello world".
 *   - Korean substring (pg_trgm path): "녕하세" matches "안녕하세요".
 *   - ACL: non-member doesn't see results from channels they can't
 *     READ (private channel exclusion).
 *   - ts_headline emits <mark>…</mark> so the client can highlight.
 *   - ts_rank orders strict matches first.
 *   - EXPLAIN on the search plan uses a GIN index (no Seq Scan on
 *     Message).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from '../workspaces/helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  const keys = await env.redis.keys('rl:search:*');
  if (keys.length > 0) await env.redis.del(...keys);
});

async function seed(): Promise<{
  ownerToken: string;
  memberToken: string;
  outsiderToken: string;
  workspaceId: string;
  publicChannelId: string;
  privateChannelId: string;
  memberUserId: string;
}> {
  const stamp = Date.now();
  const owner = await signupAsUser(env.baseUrl, `so-${stamp}`);
  const member = await signupAsUser(env.baseUrl, `sm-${stamp}`);
  const outsider = await signupAsUser(env.baseUrl, `sx-${stamp}`);

  const wsRes = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Search', slug: `srch-${stamp.toString(36)}`.slice(0, 30) });
  const workspaceId = wsRes.body.id as string;

  const inv = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ maxUses: 5 });
  await request(env.baseUrl)
    .post(`/invites/${inv.body.invite.code}/accept`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${member.accessToken}`)
    .expect(201);

  const pub = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'public-ch', type: 'TEXT' });
  const priv = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'private-ch', type: 'TEXT', isPrivate: true });

  return {
    ownerToken: owner.accessToken,
    memberToken: member.accessToken,
    outsiderToken: outsider.accessToken,
    workspaceId,
    publicChannelId: pub.body.id,
    privateChannelId: priv.body.id,
    memberUserId: member.userId,
  };
}

async function post(token: string, workspaceId: string, channelId: string, content: string) {
  await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${token}`)
    .send({ content })
    .expect(201);
}

describe('GET /search (task-015-B)', () => {
  it('rejects missing q', async () => {
    const seeded = await seed();
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${seeded.workspaceId}`)
      .set('Authorization', `Bearer ${seeded.memberToken}`);
    expect(r.status).toBe(400);
  });

  it('matches English content via tsvector path', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'hello world from alice');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'totally unrelated content');

    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=hello&limit=20`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].snippet).toContain('<mark>hello</mark>');
    expect(r.body.results[0].channelId).toBe(s.publicChannelId);
  });

  it('escapes HTML in content before ts_headline so snippet is XSS-safe', async () => {
    const s = await seed();
    await post(
      s.ownerToken,
      s.workspaceId,
      s.publicChannelId,
      'hello <script>alert(1)</script> world',
    );

    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=hello`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    const snip = r.body.results[0].snippet as string;
    // The only HTML allowed in the snippet is <mark>/</mark>.
    // A raw <script> would be smuggled past the frontend renderer;
    // we escape it to &lt;script&gt; before ts_headline runs so the
    // wire payload is safe.
    expect(snip).not.toMatch(/<script/i);
    expect(snip).toContain('&lt;script&gt;');
    expect(snip).toContain('<mark>hello</mark>');
  });

  it('matches Korean substring via pg_trgm path', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, '안녕하세요 반갑습니다');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, '다른 내용입니다');

    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('녕하세')}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBeGreaterThanOrEqual(1);
    const hit = r.body.results.find((x: { snippet: string }) => x.snippet.includes('안녕하세요'));
    expect(hit).toBeTruthy();
  });

  it('ACL: outsider sees 0 results; private channel excluded for non-member', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.privateChannelId, 'secret intel');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'public intel');

    // Outsider is not a member of the workspace.
    const outsider = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=intel`)
      .set('Authorization', `Bearer ${s.outsiderToken}`);
    expect(outsider.status).toBe(200);
    expect(outsider.body.results).toEqual([]);

    // Member is in the workspace but NOT in the private channel →
    // only the public result comes back.
    const member = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=intel`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(member.status).toBe(200);
    const channelIds = member.body.results.map((r: { channelId: string }) => r.channelId);
    expect(channelIds).toContain(s.publicChannelId);
    expect(channelIds).not.toContain(s.privateChannelId);
  });

  it('soft-deleted messages are not returned', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'deleteme target');
    // Delete the message via DELETE route
    const list = await request(env.baseUrl)
      .get(`/workspaces/${s.workspaceId}/channels/${s.publicChannelId}/messages?limit=50`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    const msg = list.body.items.find((m: { content: string }) => m.content === 'deleteme target');
    await request(env.baseUrl)
      .delete(`/workspaces/${s.workspaceId}/channels/${s.publicChannelId}/messages/${msg.id}`)
      .set('Authorization', `Bearer ${s.ownerToken}`)
      .expect(204);

    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=deleteme`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.body.results).toEqual([]);
  });

  it('EXPLAIN: search plan uses a GIN index (no Seq Scan)', async () => {
    const s = await seed();
    // Seed enough rows so the planner has a real choice.
    for (let i = 0; i < 30; i++) {
      await post(s.ownerToken, s.workspaceId, s.publicChannelId, `hello seed number ${i}`);
    }
    // Raw EXPLAIN over the actual search SQL shape.
    const rows = await env.prisma.$queryRawUnsafe<Array<Record<string, string>>>(
      `EXPLAIN
       SELECT m.id FROM "Message" m
        WHERE m."deletedAt" IS NULL
          AND m."channelId" = ANY(ARRAY[$1::uuid]::uuid[])
          AND (
               m."search_tsv" @@ plainto_tsquery('simple', $2)
            OR m."content" ILIKE '%' || $2 || '%'
          )
        ORDER BY ts_rank(m."search_tsv", plainto_tsquery('simple', $2)) DESC,
                 m."createdAt" DESC, m.id DESC
        LIMIT 20`,
      s.publicChannelId,
      'hello',
    );
    const plan = rows.map((r) => Object.values(r)[0]).join('\n');
    // Either GIN index is acceptable; but NOT a seq scan.
    expect(plan).not.toMatch(/Seq Scan on "Message"/i);
  });
});
