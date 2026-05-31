import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * task-039-A regression spec for hot-fix `712e199` + `c5146ff` +
 * `fb7f3fb`. Two friends without any common workspace exchange a DM
 * via `POST /me/dms/:channelId/messages`. The channel row should
 * carry workspaceId NULL (Global DM, task-034-A) and the history
 * endpoint should return the message just sent.
 */
describe('Global DM workspaceless message flow (int)', () => {
  let env: DmIntEnv;
  let alice: Actor;
  let bob: Actor;
  let channelId: string;

  beforeAll(async () => {
    env = await setupDmIntEnv();
    alice = await signup(env.baseUrl, 'dwa');
    bob = await signup(env.baseUrl, 'dwb');
    await makeFriends(env.baseUrl, alice, bob);

    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: bob.userId });
    if (dm.status >= 400) throw new Error(`createDm: ${dm.status} ${dm.text}`);
    channelId = dm.body.channelId as string;
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  });

  it('persists the DM channel with workspaceId NULL', async () => {
    const ch = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(ch).not.toBeNull();
    expect(ch?.type).toBe('DIRECT');
    expect(ch?.workspaceId).toBeNull();
  });

  it('POST /me/dms/:channelId/messages → history visible to both participants', async () => {
    const post = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken))
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({ content: 'workspaceless hello' });
    expect(post.status).toBe(201);
    expect(post.body.message.content).toBe('workspaceless hello');

    // Sender history
    const aHist = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken));
    expect(aHist.status).toBe(200);
    expect(aHist.body.items).toHaveLength(1);
    expect(aHist.body.items[0].content).toBe('workspaceless hello');

    // Recipient history — same channel, different bearer
    const bHist = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(bob.accessToken));
    expect(bHist.status).toBe(200);
    expect(bHist.body.items[0].id).toBe(post.body.message.id);
  });

  it('rejects a non-participant with 403 CHANNEL_NOT_VISIBLE', async () => {
    const eve = await signup(env.baseUrl, 'dwe');
    const r = await request(env.baseUrl)
      .get(`/me/dms/${channelId}/messages`)
      .set(bearer(eve.accessToken));
    // task-039 review MED-1: DmChannelAccessGuard deterministically
    // throws CHANNEL_NOT_VISIBLE (403) for a live DIRECT channel that
    // the caller has no ALLOW override on. The 404 path only fires
    // when the channel is missing — not a state this test produces —
    // so lock to 403.
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('CHANNEL_NOT_VISIBLE');
  });

  it('idempotency key replays the same row', async () => {
    const key = '22222222-2222-4222-8222-222222222222';
    const a = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken))
      .set('Idempotency-Key', key)
      .send({ content: 'replay test' });
    expect(a.status).toBe(201);
    const b = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken))
      .set('Idempotency-Key', key)
      .send({ content: 'replay test' });
    expect(b.status).toBe(200);
    expect(b.body.message.id).toBe(a.body.message.id);
    expect(b.headers['idempotency-replayed']).toBe('true');
  });

  // S05 verify (BLOCKER fix): MessageAuthorGuard 가 `:chid` 만 읽어 DM 라우트
  // (`me/dms/:channelId/messages`)의 PATCH 가 무조건 400 VALIDATION_FAILED 였다.
  // 가드를 `chid ?? channelId` 로 고쳐 DM 편집이 실제로 동작함을 증명한다.
  it('PATCH /me/dms/:channelId/messages/:msgId → 작성자 편집 성공(version+1, edited)', async () => {
    const post = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken))
      .send({ content: 'dm to edit' });
    expect(post.status).toBe(201);
    const msgId = post.body.message.id as string;
    expect(post.body.message.version).toBe(0);

    const patch = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/messages/${msgId}`)
      .set(bearer(alice.accessToken))
      .send({ content: 'dm edited', expectedVersion: 0 });
    expect(patch.status).toBe(200);
    expect(patch.body.message.content).toBe('dm edited');
    expect(patch.body.message.edited).toBe(true);
    expect(patch.body.message.version).toBe(1);
  });

  it('PATCH by non-author(recipient) → 403 MESSAGE_NOT_AUTHOR (400 아님)', async () => {
    const post = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken))
      .send({ content: 'alice only' });
    const msgId = post.body.message.id as string;

    const patch = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/messages/${msgId}`)
      .set(bearer(bob.accessToken))
      .send({ content: 'bob hijack', expectedVersion: 0 });
    expect(patch.status).toBe(403);
    expect(patch.body.errorCode).toBe('MESSAGE_NOT_AUTHOR');
  });
});
