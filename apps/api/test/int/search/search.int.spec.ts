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
// S29 baseline fix: frozen Date.now() 하에서 seed() 간 slug 고유화용 카운터.
let seedCounter = 0;

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
  ownerUsername: string;
}> {
  // S29 baseline fix: vi.setSystemTime 가 Date.now() 를 고정하므로 prefix 에
  // stamp 를 붙이면 helper 가 더하는 stamp 와 합쳐져 username max(32) 를
  // 넘긴다(signup 400). prefix 는 짧게 두고 uniqueness 는 helper 의 stamp+rand
  // 에 맡긴다. 또한 workspace slug 도 frozen Date.now() 면 seed() 마다 동일해
  // 2번째 호출부터 slug 충돌이 났다 — 모노톤 카운터로 고유화한다.
  const uniq = (seedCounter += 1);
  const owner = await signupAsUser(env.baseUrl, 'so');
  const member = await signupAsUser(env.baseUrl, 'sm');
  const outsider = await signupAsUser(env.baseUrl, 'sx');

  const wsRes = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Search', slug: `srch-${uniq}-${Math.floor(Math.random() * 1e6)}`.slice(0, 30) });
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
    ownerUsername: owner.username,
  };
}

// S29: from:@<owner> 토큰 구성을 위한 헬퍼(seed 가 username 을 노출).
async function ownerName(s: { ownerUsername: string }): Promise<string> {
  return s.ownerUsername;
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
    //
    // S29 baseline note: ts_headline 의 MaxWords=18,MinWords=3 윈도가 escape
    // 된 본문(`&lt;script&gt;alert(1)&lt;/script&gt;` 가 다수 lexeme 으로 분해)
    // 을 `&lt;script` 직후에서 잘라 닫는 `&gt;` 가 fragment 밖으로 나간다. 핵심
    // 보안 속성(살아있는 `<script` 없음 = XSS-safe)은 그대로 유지되며, 검증은
    // escape 가 실제로 일어났음(`&lt;script` 존재)으로 충분하다. ts_rank →
    // ts_rank_cd 전환과 무관(headline 은 rank 와 독립).
    expect(snip).not.toMatch(/<script/i);
    expect(snip).toContain('&lt;script');
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

  // ── S29 (search core) ────────────────────────────────────────────────────

  it('S29 FR-S04 오라클 방지: in:#<비공개 비멤버 채널> → 0건(존재 미노출)', async () => {
    const s = await seed();
    // 비공개 채널에 owner 가 메시지 작성. member 는 비멤버.
    await post(s.ownerToken, s.workspaceId, s.privateChannelId, 'oracle secret payload');

    // member 가 in:#private-ch 로 지정해도 0건이어야 한다(403/404 아님).
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('in:#private-ch payload')}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([]);

    // from:@owner in:#private-ch (비멤버) 조합도 0건.
    const r2 = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('from:@' + (await ownerName(s)) + ' in:#private-ch payload')}`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r2.status).toBe(200);
    expect(r2.body.results).toEqual([]);
  });

  it('S29 FR-S04: 미존재 from:@user → 0건(외부 사용자 존재 미노출)', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'visible message body');
    const r = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('from:@nobody-xyz message')}`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([]);
  });

  it('S29 FR-S05: in:#public-ch 가시 채널은 정상 매칭', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'scoped lookup target');
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('in:#public-ch target')}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].channelId).toBe(s.publicChannelId);
  });

  it('S29 FR-S05: from:@<author> 필터 — 다른 작성자 메시지 제외', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'budget owner note');
    await post(s.memberToken, s.workspaceId, s.publicChannelId, 'budget member note');
    const r = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('from:@' + (await ownerName(s)) + ' budget')}`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].senderName).toBe(await ownerName(s));
  });

  it('S29 FR-S05: has:link — 링크 포함 메시지만(send 경로가 hasLink 유지)', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'plain note no url here');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'see https://example.com note');
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('has:link note')}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].snippet).toContain('example.com');
  });

  it('S29 FR-S05: has:image — 비정규화 플래그 직접 세팅분 매칭', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'image carrier alpha');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'image carrier beta');
    // 첫 메시지에만 hasImage 플래그를 세팅(첨부 presign 경로 대신 직접 — int).
    const msg = await env.prisma.message.findFirst({
      where: { channelId: s.publicChannelId, contentPlain: 'image carrier alpha' },
      select: { id: true },
    });
    await env.prisma.message.update({ where: { id: msg!.id }, data: { hasImage: true } });
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('has:image carrier')}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].messageId).toBe(msg!.id);
  });

  it('S29 FR-S05: is:pinned — pinnedAt IS NOT NULL 만', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'pinme announcement');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'unpinned announcement');
    // is:pinned 은 pinnedAt IS NOT NULL 로 평가한다. pin HTTP 경로는 별개
    // (advisory-lock void deserialize) 슬라이스 관심사라, 검색 필터 자체를
    // 검증하기 위해 pinnedAt 을 직접 세팅한다.
    const pinTarget = await env.prisma.message.findFirst({
      where: { channelId: s.publicChannelId, contentPlain: 'pinme announcement' },
      select: { id: true },
    });
    await env.prisma.message.update({
      where: { id: pinTarget!.id },
      data: { pinnedAt: new Date('2025-01-01T00:00:00Z') },
    });
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('is:pinned announcement')}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].messageId).toBe(pinTarget!.id);
  });

  it('S29 FR-S05: before/after 일자 경계 필터', async () => {
    const s = await seed();
    // vi.setSystemTime 가 2025-01-01 이므로 메시지 createdAt 도 그 시각.
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'boundary dated message');
    // after:2024-12-31 → >= 2025-01-01 자정 → 포함.
    const inRange = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('after:2024-12-31 boundary')}`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(inRange.body.results).toHaveLength(1);
    // before:2025-01-01 → < 2025-01-01 자정 → 제외(0건).
    const outRange = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('before:2025-01-01 boundary')}`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(outRange.body.results).toEqual([]);
  });

  it('S29 FR-S08: sort=recent 는 createdAt DESC 정렬', async () => {
    const s = await seed();
    // 동일 토큰을 시간차로 3개 — recent 정렬이면 마지막 작성이 맨 앞.
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'chrono token one');
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'chrono token two');
    vi.setSystemTime(new Date('2025-01-01T00:02:00Z'));
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'chrono token three');
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=chrono&sort=recent`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBeGreaterThanOrEqual(3);
    const times = r.body.results.map((x: { createdAt: string }) => new Date(x.createdAt).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  // ── S29 fix-forward (4팀 리뷰) ───────────────────────────────────────────

  it('S29 security: per-result ACL 필터 — 쿼리 후 비공개 전환된 채널 결과 제외', async () => {
    const s = await seed();
    // member 가 가입한 추가 공개 채널 2개. 둘 다 가시.
    const aRes = await request(env.baseUrl)
      .post(`/workspaces/${s.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${s.ownerToken}`)
      .send({ name: 'acl-a', type: 'TEXT' });
    const bRes = await request(env.baseUrl)
      .post(`/workspaces/${s.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${s.ownerToken}`)
      .send({ name: 'acl-b', type: 'TEXT' });
    const chA = aRes.body.id as string;
    const chB = bRes.body.id as string;
    await post(s.ownerToken, s.workspaceId, chA, 'aclflip token visible');
    await post(s.ownerToken, s.workspaceId, chB, 'aclflip token hidden');

    // 기준선: member 는 두 채널 모두 가시 → 두 결과.
    const before = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=aclflip`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(before.status).toBe(200);
    const beforeChannels = before.body.results.map((r: { channelId: string }) => r.channelId);
    expect(beforeChannels).toContain(chA);
    expect(beforeChannels).toContain(chB);

    // chB 를 비공개로 전환 → member 는 비멤버라 더 이상 가시하지 않는다.
    // visibleChannelIds 스냅샷이 stale 하더라도 search() 의 per-result Set
    // 필터가 chB 행을 응답에서 제외해야 한다.
    await env.prisma.channel.update({ where: { id: chB }, data: { isPrivate: true } });

    const after = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=aclflip`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(after.status).toBe(200);
    const afterChannels = after.body.results.map((r: { channelId: string }) => r.channelId);
    expect(afterChannels).toContain(chA);
    expect(afterChannels).not.toContain(chB);
  });

  it('S29 security: 비-UUID workspaceId 는 400(Prisma 500 누출 방지)', async () => {
    const s = await seed();
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=not-a-uuid&q=hello`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(400);
  });

  it('S29 security: 비-UUID channelId / senderId 는 400', async () => {
    const s = await seed();
    const rc = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=hello&channelId=bogus`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(rc.status).toBe(400);
    const rs = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=hello&senderId=bogus`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(rs.status).toBe(400);
  });

  it('S29 security: q 길이 상한(500 초과) 은 400(DoS 풀스캔 방지)', async () => {
    const s = await seed();
    const huge = 'a'.repeat(501);
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent(huge)}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(400);
  });

  it('S29 M1: has:attachment — finalized 첨부 연결 메시지만(deletedAt→finalizedAt 교정)', async () => {
    const s = await seed();
    // 실 send 경로로 메시지 2개 작성.
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'attach carrier with file');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'attach carrier plain text');
    const withAtt = await env.prisma.message.findFirst({
      where: { channelId: s.publicChannelId, contentPlain: 'attach carrier with file' },
      select: { id: true },
    });
    const withoutAtt = await env.prisma.message.findFirst({
      where: { channelId: s.publicChannelId, contentPlain: 'attach carrier plain text' },
      select: { id: true },
    });
    // 첫 메시지에 finalized 첨부 1건 연결(presign 경로 대신 직접 — int).
    // hasAttachment 절은 Attachment.finalizedAt IS NOT NULL 을 본다(이전엔
    // 존재하지 않는 deletedAt 컬럼을 참조해 잠재 크래시 → finalizedAt 으로 교정).
    await env.prisma.attachment.create({
      data: {
        channelId: s.publicChannelId,
        messageId: withAtt!.id,
        uploaderId: s.memberUserId,
        kind: 'FILE',
        mime: 'application/pdf',
        sizeBytes: BigInt(1234),
        storageKey: `att/${withAtt!.id}/doc.pdf`,
        originalName: 'doc.pdf',
        finalizedAt: new Date('2025-01-01T00:00:00Z'),
      },
    });
    // 미finalize(finalizedAt NULL) 첨부는 hasAttachment 매칭에서 제외돼야 한다.
    await env.prisma.attachment.create({
      data: {
        channelId: s.publicChannelId,
        messageId: withoutAtt!.id,
        uploaderId: s.memberUserId,
        kind: 'FILE',
        mime: 'application/pdf',
        sizeBytes: BigInt(99),
        storageKey: `att/${withoutAtt!.id}/pending.pdf`,
        originalName: 'pending.pdf',
        finalizedAt: null,
      },
    });

    const r = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('carrier')}&hasAttachment=true`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    const ids = r.body.results.map((x: { messageId: string }) => x.messageId);
    expect(ids).toContain(withAtt!.id);
    expect(ids).not.toContain(withoutAtt!.id);
  });

  // ── S30 (결과 컨텍스트 / 스레드 / 최근검색) ───────────────────────────────

  it('S30 FR-S06: withContext — 결과의 전/후 1메시지 컨텍스트 첨부', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'context boundary before');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'context target needle');
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'context boundary after');

    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=needle&withContext=true`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    const hit = r.body.results[0];
    expect(hit.contextBefore).toBeTruthy();
    expect(hit.contextBefore.masked).toBe(false);
    expect(hit.contextBefore.text).toContain('context boundary before');
    expect(hit.contextAfter).toBeTruthy();
    expect(hit.contextAfter.masked).toBe(false);
    expect(hit.contextAfter.text).toContain('context boundary after');
  });

  it('S30 FR-S06: 컨텍스트 권한 재검증 — 쿼리 후 비공개 전환된 채널의 인접 메시지 마스킹', async () => {
    const s = await seed();
    // member 가 가입한 공개 채널.
    const chRes = await request(env.baseUrl)
      .post(`/workspaces/${s.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${s.ownerToken}`)
      .send({ name: 'ctx-acl', type: 'TEXT' });
    const ch = chRes.body.id as string;
    await post(s.ownerToken, s.workspaceId, ch, 'ctxacl prior message');
    await post(s.ownerToken, s.workspaceId, ch, 'ctxacl matched needle');
    await post(s.ownerToken, s.workspaceId, ch, 'ctxacl next message');

    // 기준선: member 가시 → 컨텍스트 본문 노출.
    const before = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=needle&withContext=true&channelId=${ch}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(before.status).toBe(200);
    expect(before.body.results[0].contextBefore.masked).toBe(false);

    // 채널을 비공개로 전환 → member 비멤버. visibleChannelIds 스냅샷이 stale
    // 하더라도 per-msg 권한 재검증이 인접 메시지를 마스킹해야 한다.
    // (결과 행 자체는 per-result Set 필터로 제외되므로, 마스킹은 컨텍스트
    // 계산 시 visibleSet 에서 채널이 빠진 경우를 직접 검증한다.)
    await env.prisma.channel.update({ where: { id: ch }, data: { isPrivate: true } });
    const after = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=needle&withContext=true&channelId=${ch}`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(after.status).toBe(200);
    // 비공개 전환 후 결과 자체가 제외(per-result ACL) → 0건.
    expect(after.body.results).toEqual([]);
  });

  it('S30 FR-S10: 스레드 답글 검색 — In Thread + 루트 excerpt, 루트채널 가시성', async () => {
    const s = await seed();
    // 루트 메시지 작성 후 답글 작성.
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'thread root anchor topic');
    const list = await request(env.baseUrl)
      .get(`/workspaces/${s.workspaceId}/channels/${s.publicChannelId}/messages?limit=50`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    const root = list.body.items.find(
      (m: { content: string }) => m.content === 'thread root anchor topic',
    );
    await request(env.baseUrl)
      .post(`/workspaces/${s.workspaceId}/channels/${s.publicChannelId}/messages`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${s.ownerToken}`)
      .send({ content: 'reply needle inside thread', parentMessageId: root.id })
      .expect(201);

    const r = await request(env.baseUrl)
      .get(
        `/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent('reply needle')}&withContext=true`,
      )
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    const reply = r.body.results.find((x: { snippet: string }) => x.snippet.includes('needle'));
    expect(reply).toBeTruthy();
    expect(reply.inThread).toBe(true);
    expect(reply.threadRootExcerpt).toContain('thread root anchor topic');
  });

  it('S30 FR-S10: 비스레드 결과는 inThread=false + threadRootExcerpt null', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'standalone lonely needle');
    const r = await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=lonely&withContext=true`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(r.status).toBe(200);
    const hit = r.body.results[0];
    expect(hit.inThread).toBe(false);
    expect(hit.threadRootExcerpt).toBeNull();
  });

  it('S30 FR-S07: 최근 검색 — 결과 쿼리 후 GET /search/recent 에 newest-first 노출', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'recenttoken alpha body');
    // 세 번 검색 — 중복 제거 + newest-first 확인.
    await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=recenttoken`)
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(200);
    await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=alpha`)
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(200);
    // 중복(recenttoken 재검색) → 한 번만 남고 맨 앞으로.
    await request(env.baseUrl)
      .get(`/search?workspaceId=${s.workspaceId}&q=recenttoken`)
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(200);

    const recent = await request(env.baseUrl)
      .get(`/search/recent`)
      .set('Authorization', `Bearer ${s.memberToken}`);
    expect(recent.status).toBe(200);
    expect(recent.body.recents[0]).toBe('recenttoken');
    expect(recent.body.recents).toContain('alpha');
    // 중복 제거 — recenttoken 은 1회만.
    expect(recent.body.recents.filter((x: string) => x === 'recenttoken')).toHaveLength(1);
  });

  it('S31 FR-S11: DELETE /search/recent?q=<entry> 개별 삭제 + DELETE 전체 삭제', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'delrec alpha bravo body');
    for (const q of ['delrec', 'alpha', 'bravo']) {
      await request(env.baseUrl)
        .get(`/search?workspaceId=${s.workspaceId}&q=${q}`)
        .set('Authorization', `Bearer ${s.memberToken}`)
        .expect(200);
    }
    // 전부 들어갔는지 확인.
    const before = await request(env.baseUrl)
      .get('/search/recent')
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(200);
    expect(before.body.recents).toContain('alpha');

    // 개별 삭제: alpha 만 제거.
    await request(env.baseUrl)
      .delete(`/search/recent?q=${encodeURIComponent('alpha')}`)
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(204);
    const afterOne = await request(env.baseUrl)
      .get('/search/recent')
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(200);
    expect(afterOne.body.recents).not.toContain('alpha');
    expect(afterOne.body.recents).toContain('bravo');

    // 전체 삭제.
    await request(env.baseUrl)
      .delete('/search/recent')
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(204);
    const afterAll = await request(env.baseUrl)
      .get('/search/recent')
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(200);
    expect(afterAll.body.recents).toHaveLength(0);
  });

  it('S31 security: DELETE /search/recent?q 가 200자 초과면 400 (Redis LREM DoS 차단)', async () => {
    const s = await seed();
    const huge = 'a'.repeat(201);
    await request(env.baseUrl)
      .delete(`/search/recent?q=${encodeURIComponent(huge)}`)
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(400);
  });

  it('S31 FR-S11: DELETE /search/recent 는 다른 사용자 데이터에 영향 없음(IDOR 차단)', async () => {
    const s = await seed();
    await post(s.ownerToken, s.workspaceId, s.publicChannelId, 'idortoken body here');
    // owner 와 member 둘 다 동일 토큰 검색 → 각자 recent 에 기록.
    for (const tok of [s.ownerToken, s.memberToken]) {
      await request(env.baseUrl)
        .get(`/search?workspaceId=${s.workspaceId}&q=idortoken`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(200);
    }
    // member 가 전체 삭제 → owner 의 recent 는 그대로.
    await request(env.baseUrl)
      .delete('/search/recent')
      .set('Authorization', `Bearer ${s.memberToken}`)
      .expect(204);
    const ownerRecent = await request(env.baseUrl)
      .get('/search/recent')
      .set('Authorization', `Bearer ${s.ownerToken}`)
      .expect(200);
    expect(ownerRecent.body.recents).toContain('idortoken');
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
