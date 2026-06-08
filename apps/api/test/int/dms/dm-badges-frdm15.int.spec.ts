import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { UnreadService } from '../../../src/channels/unread.service';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * S? 슬라이스 (FR-DM-15) — DM 미읽/멘션 배지 회귀 spec.
 *
 * 계약(064): GET /me/dms 응답에 per-DM `mentionCount` 를 노출한다. 멘션 카운트는
 * unreadCount 서브쿼리와 동일한 술어로 산정한다(읽음 커서 (createdAt,id) > lastRead,
 * roots-only(parentMessageId IS NULL OR isBroadcast), deletedAt IS NULL) + 멘션
 * 매칭(common/acl mentionMatchSql: users @> / everyone / here / channel).
 *
 * ★현실 제약: Global DM(workspaceId=null) 메시지는 extractMentions 가 멘션을 전부
 * 드롭하므로, 정상 send 경로로는 mentions JSONB 가 항상 비어 mentionCount=0 이다.
 * 따라서 서브쿼리의 "멘션 매칭 정확성" 은 prisma 로 mentions JSONB 를 직접 set 한
 * 메시지 행으로 검증한다(서브쿼리 술어가 unread 와 일관됨을 보장하는 것이 목적).
 * 정상 send-only 경로(멘션 없음)에서는 mentionCount=0 이 노출됨을 함께 검증한다.
 */
describe('FR-DM-15 DM unread/mention 배지 (int)', () => {
  let env: DmIntEnv;

  beforeAll(async () => {
    env = await setupDmIntEnv();
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  }, 60_000);

  /** 두 친구 사이 1:1 DM 개설 → channelId. */
  async function openDm(a: Actor, b: Actor): Promise<string> {
    await makeFriends(env.baseUrl, a, b);
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(a.accessToken))
      .send({ userId: b.userId });
    if (dm.status >= 400) throw new Error(`createDm: ${dm.status} ${dm.text}`);
    return dm.body.channelId as string;
  }

  async function sendDm(actor: Actor, channelId: string, content: string): Promise<string> {
    const res = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(actor.accessToken))
      .send({ content });
    if (res.status >= 400) throw new Error(`sendDm: ${res.status} ${res.text}`);
    return res.body.message.id as string;
  }

  /** GET /me/dms 에서 channelId 행을 찾는다. */
  async function dmRow(
    actor: Actor,
    channelId: string,
  ): Promise<{ unreadCount: number; mentionCount: number } | undefined> {
    const res = await request(env.baseUrl).get('/me/dms').set(bearer(actor.accessToken));
    if (res.status >= 400) throw new Error(`list dms: ${res.status} ${res.text}`);
    return res.body.items.find((i: { channelId: string }) => i.channelId === channelId);
  }

  it('GET /me/dms 응답이 mentionCount 필드를 노출한다(멘션 없으면 0)', async () => {
    const a = await signup(env.baseUrl, 'bdg-a');
    const b = await signup(env.baseUrl, 'bdg-b');
    const channelId = await openDm(a, b);

    // b 가 두 통 보냄(멘션 없는 일반 텍스트). a 는 미읽음 2 / 멘션 0.
    await sendDm(b, channelId, 'hello there');
    await sendDm(b, channelId, 'are you around?');

    const row = await dmRow(a, channelId);
    expect(row).toBeDefined();
    expect(row!.unreadCount).toBe(2);
    // FR-DM-15: mentionCount 필드가 응답 contract 에 포함된다(현 데이터상 0).
    expect(row!.mentionCount).toBe(0);
  });

  it('mentions.users 에 본인이 담긴 미읽음 메시지를 mentionCount 로 센다(읽음 커서·roots-only·deletedAt 일관)', async () => {
    const a = await signup(env.baseUrl, 'bdg-m-a');
    const b = await signup(env.baseUrl, 'bdg-m-b');
    const channelId = await openDm(a, b);

    // 메시지 4통: ①@a 멘션 root ②일반 root ③@a 멘션 root(추후 삭제) ④@a 멘션 reply.
    const m1 = await sendDm(b, channelId, 'first one');
    await sendDm(b, channelId, 'plain text');
    const m3 = await sendDm(b, channelId, 'mention again');
    const m4 = await sendDm(b, channelId, 'a reply');

    // Global DM 은 extractMentions 가 멘션을 드롭하므로 JSONB 를 직접 주입해
    // 서브쿼리의 멘션 매칭/커서/roots-only/deletedAt 일관성을 검증한다.
    const mentionA = {
      users: [a.userId],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
      roles: [],
    };
    await env.prisma.message.update({ where: { id: m1 }, data: { mentions: mentionA } });
    await env.prisma.message.update({
      where: { id: m3 },
      // m3 는 @a 멘션이지만 soft-delete → mentionCount 에서 제외돼야 한다(deletedAt 일관).
      data: { mentions: mentionA, deletedAt: new Date() },
    });
    await env.prisma.message.update({
      where: { id: m4 },
      // m4 는 @a 멘션이지만 스레드 답글(parentMessageId 존재, isBroadcast=false)
      // → roots-only 술어로 제외돼야 한다(unread 서브쿼리와 동일).
      data: { mentions: mentionA, parentMessageId: m1, isBroadcast: false },
    });

    // a 시점: 미읽음 멘션은 m1 하나(m3 삭제·m4 reply 제외). unread root 는 m1·m2(=2).
    const before = await dmRow(a, channelId);
    expect(before!.unreadCount).toBe(2);
    expect(before!.mentionCount).toBe(1);
  });

  it('읽음 커서를 전진시키면 mentionCount 가 0 으로 수렴한다(unread 와 동일 커서)', async () => {
    const a = await signup(env.baseUrl, 'bdg-r-a');
    const b = await signup(env.baseUrl, 'bdg-r-b');
    const channelId = await openDm(a, b);

    const m1 = await sendDm(b, channelId, 'ping one');
    const m2 = await sendDm(b, channelId, 'ping two');
    const mentionA = {
      users: [a.userId],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
      roles: [],
    };
    await env.prisma.message.update({ where: { id: m1 }, data: { mentions: mentionA } });
    await env.prisma.message.update({ where: { id: m2 }, data: { mentions: mentionA } });

    const before = await dmRow(a, channelId);
    expect(before!.mentionCount).toBe(2);

    // a 가 최신(m2)까지 읽음 ACK → 커서 전진. DM 읽음은 WS(channel:read)를 거치므로
    // int 에서는 동일 ackRead 서비스 메서드를 직접 호출(WS 연결 우회). unread 와
    // mention 모두 동일 커서 술어를 쓰므로 둘 다 0 으로 수렴해야 한다.
    const unread = env.app.get(UnreadService);
    await unread.ackRead({ userId: a.userId, channelId, lastReadMessageId: m2 });

    const after = await dmRow(a, channelId);
    expect(after!.unreadCount).toBe(0);
    expect(after!.mentionCount).toBe(0);
  });

  it('PATCH /me/dms/:channelId/mute 후에도 GET /me/dms 가 mentionCount 를 그대로 노출한다(뮤트는 unread 억제, 멘션 카운트 자체는 불변)', async () => {
    const a = await signup(env.baseUrl, 'bdg-mu-a');
    const b = await signup(env.baseUrl, 'bdg-mu-b');
    const channelId = await openDm(a, b);

    const m1 = await sendDm(b, channelId, 'muted ping');
    const mentionA = {
      users: [a.userId],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
      roles: [],
    };
    await env.prisma.message.update({ where: { id: m1 }, data: { mentions: mentionA } });

    // a 가 DM 을 무기한 뮤트.
    const mute = await request(env.baseUrl)
      .patch(`/me/dms/${channelId}/mute`)
      .set(bearer(a.accessToken))
      .send({ mutedUntil: null });
    expect(mute.status).toBe(200);

    // 서버 mentionCount 는 뮤트 무관(클라 dmRowBadge 가 뮤트 시 mention 만 표시).
    const row = await dmRow(a, channelId);
    expect(row!.unreadCount).toBe(1);
    expect(row!.mentionCount).toBe(1);

    // /me/mutes 가 이 채널을 활성 뮤트로 노출한다.
    const mutes = await request(env.baseUrl).get('/me/mutes').set(bearer(a.accessToken));
    expect(mutes.body.items.map((i: { channelId: string }) => i.channelId)).toContain(channelId);
  });
});
