import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DM_CREATED } from '../../../src/channels/events/channel-events';
import { bearer, makeFriends, setupDmIntEnv, signup, type Actor, type DmIntEnv } from './helpers';

/**
 * S16 (D03) — DM 개설/목록/실시간 회귀 spec.
 *
 *  - FR-DM-01: 1:1 DM createOrGet 중복 금지(같은 pair → 같은 channelId).
 *              숨겨진 DM 복원 시 friendship(=privacy 게이트) 재검증.
 *  - FR-DM-02: 그룹 DM 개설, 본인 포함 ≤20 cap, 초과 시 422.
 *  - FR-DM-03: 목록 shape — unreadCount + lastMessage 미리보기 + participants(≤5).
 *  - FR-DM-16: dm.created outbox 이벤트가 기록·dispatch 된다(participantIds +
 *              recipients). recipients 는 **내부 EventEmitter envelope 전용**(라우팅)
 *              이며 소켓 와이어 페이로드에서는 제거된다(H-03). 본 spec 은 내부
 *              envelope 를 검사하므로 recipients 가 보인다.
 */
describe('S16 DM 개설/목록/실시간 (int)', () => {
  let env: DmIntEnv;
  let alice: Actor;
  let bob: Actor;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    env = await setupDmIntEnv();
    alice = await signup(env.baseUrl, 's16a');
    bob = await signup(env.baseUrl, 's16b');
    await makeFriends(env.baseUrl, alice, bob);
    emitter = env.app.get(EventEmitter2);
  }, 240_000);

  afterAll(async () => {
    await env.stop();
  }, 60_000);

  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  // ── FR-DM-01: 1:1 중복 금지 ────────────────────────────────────────────
  it('FR-DM-01: createOrGet 은 같은 pair 에 대해 같은 channelId 를 반환한다(중복 금지)', async () => {
    const first = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: bob.userId });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    // 같은 방향 재요청 → created:false + 동일 channelId
    const second = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: bob.userId });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(false);
    expect(second.body.channelId).toBe(first.body.channelId);

    // 반대 방향(bob→alice)도 같은 채널로 수렴(정렬 slug = participantHash 동등 메커니즘)
    const reverse = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(bob.accessToken))
      .send({ userId: alice.userId });
    expect(reverse.status).toBe(201);
    expect(reverse.body.channelId).toBe(first.body.channelId);

    // DB 상에 해당 pair 의 활성 DIRECT 채널은 정확히 1개
    const channels = await env.prisma.channel.findMany({
      where: {
        type: 'DIRECT',
        deletedAt: null,
        workspaceId: null,
        name: { not: { startsWith: 'gdm:' } },
      },
    });
    const pairChannels = channels.filter((c) => c.id === first.body.channelId);
    expect(pairChannels).toHaveLength(1);
  });

  it('FR-DM-01: 친구가 아닌 상대에게는 403(privacy/friend 게이트, FRIEND_NOT_FOUND)', async () => {
    const stranger = await signup(env.baseUrl, 's16x');
    const res = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: stranger.userId });
    expect(res.status).toBe(404); // FRIEND_NOT_FOUND → 404 (privacy 미충족)
    expect(res.body.errorCode).toBe('FRIEND_NOT_FOUND');
  });

  // ── FR-DM-02: 그룹 DM + cap 422 ───────────────────────────────────────
  it('FR-DM-02: 그룹 DM 개설(본인 포함 3명) — 멤버 전원 친구일 때', async () => {
    const carol = await signup(env.baseUrl, 's16c');
    // S16 (BLOCKER fix-forward): 전역 그룹은 각 멤버가 개설자의 친구여야 한다.
    await makeFriends(env.baseUrl, alice, carol);
    const res = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds: [bob.userId, carol.userId] });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.memberIds).toHaveLength(3);
    expect(res.body.memberIds).toContain(alice.userId);
  });

  it('FR-DM-02 (BLOCKER fix-forward): 비친구 memberId 가 포함된 그룹은 거부(친구 게이트)', async () => {
    // bob 은 alice 의 친구(beforeAll). stranger 는 친구 아님 → 그룹 편입 거부.
    const stranger = await signup(env.baseUrl, 's16g');
    const res = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds: [bob.userId, stranger.userId] });
    // 미친구·차단 모두 동일 status(404 FRIEND_NOT_FOUND) + 중립 메시지(H-03).
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('FRIEND_NOT_FOUND');
    // 차단 여부 비노출: 메시지에 "blocked"/"friend" 단서가 없어야 한다.
    expect(String(res.body.message)).not.toMatch(/blocked|not friends/i);
  });

  it('HIGH fix-forward: 비-UUID memberId → 400 (ValidationPipe)', async () => {
    const res = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds: ['not-a-uuid', bob.userId] });
    expect(res.status).toBe(400);
  });

  it('MED fix-forward: 동일 member-set 그룹 재생성 → created:false + 동일 channelId (현재 dedup 동작)', async () => {
    const h1 = await signup(env.baseUrl, 's16h');
    const i1 = await signup(env.baseUrl, 's16i');
    await makeFriends(env.baseUrl, alice, h1);
    await makeFriends(env.baseUrl, alice, i1);

    const first = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds: [h1.userId, i1.userId] });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    // 같은 구성원 set(순서 무관) 재요청 → 기존 채널 반환.
    const second = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds: [i1.userId, h1.userId] });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(false);
    expect(second.body.channelId).toBe(first.body.channelId);
  });

  it('FR-DM-02: 본인 포함 20명 초과(=본인 외 20명) → 422 DM_GROUP_CAP_EXCEEDED', async () => {
    // 본인 외 20명(총 21) → cap 초과. 실제 user 를 만들 필요 없이 cap 검증이
    // 멤버 수에서 먼저 끊기므로 uuid placeholder 20개를 보낸다.
    const memberIds = Array.from(
      { length: 20 },
      (_, i) => `00000000-0000-4000-8000-0000000000${(i + 10).toString().padStart(2, '0')}`,
    );
    const res = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('DM_GROUP_CAP_EXCEEDED');
  });

  // ── FR-DM-03: 목록 shape ──────────────────────────────────────────────
  it('FR-DM-03: GET /me/dms 가 unreadCount + lastMessage 미리보기 + participants(≤5) 를 싣는다', async () => {
    // alice→bob 1:1 DM 보장 + 메시지 1건
    const dm = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: bob.userId });
    const channelId = dm.body.channelId as string;
    const post = await request(env.baseUrl)
      .post(`/me/dms/${channelId}/messages`)
      .set(bearer(alice.accessToken))
      .send({ content: 'preview probe' });
    expect(post.status).toBe(201);

    // 수신자(bob) 시점: 자기 미읽음으로 잡혀야 함
    const list = await request(env.baseUrl).get('/me/dms').set(bearer(bob.accessToken));
    expect(list.status).toBe(200);
    const row = list.body.items.find((d: { channelId: string }) => d.channelId === channelId);
    expect(row).toBeDefined();
    expect(typeof row.unreadCount).toBe('number');
    expect(row.unreadCount).toBeGreaterThanOrEqual(1);
    expect(row.lastMessagePreview).toBe('preview probe');
    expect(row.lastMessageAt).not.toBeNull();
    expect(Array.isArray(row.participants)).toBe(true);
    expect(row.participants.length).toBeGreaterThanOrEqual(1);
    expect(row.participants.length).toBeLessThanOrEqual(5);
    expect(row.participants[0]).toMatchObject({ userId: alice.userId, username: alice.username });
  });

  // ── FR-DM-16: dm.created emit ─────────────────────────────────────────
  it('FR-DM-16: 새 1:1 DM 개설 시 dm.created 가 기록·dispatch 되고 recipients 에 양쪽이 담긴다', async () => {
    const dave = await signup(env.baseUrl, 's16d');
    await makeFriends(env.baseUrl, alice, dave);

    const received: Array<Record<string, unknown>> = [];
    const handler = (e: Record<string, unknown>): void => {
      received.push(e);
    };
    emitter.on(DM_CREATED, handler);

    const res = await request(env.baseUrl)
      .post('/me/dms')
      .set(bearer(alice.accessToken))
      .send({ userId: dave.userId });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const channelId = res.body.channelId as string;

    // outbox row 기록(미dispatch)
    const before = await env.prisma.outboxEvent.findFirst({
      where: { eventType: DM_CREATED, aggregateId: channelId },
    });
    expect(before).toBeTruthy();
    expect(before!.dispatchedAt).toBeNull();

    const n = await env.dispatcher.drain();
    expect(n).toBeGreaterThanOrEqual(1);

    const after = await env.prisma.outboxEvent.findUnique({ where: { id: before!.id } });
    expect(after!.dispatchedAt).not.toBeNull();

    const ev = received.find((e) => (e as { channelId?: string }).channelId === channelId);
    expect(ev).toBeDefined();
    expect(ev!.isGroup).toBe(false);
    expect(ev!.recipients).toEqual(expect.arrayContaining([alice.userId, dave.userId]));
    expect(ev!.participantIds).toEqual(expect.arrayContaining([alice.userId, dave.userId]));

    emitter.off(DM_CREATED, handler);
  });

  it('FR-DM-16: 그룹 DM 개설 시 dm.created(isGroup=true) 가 멤버 전원을 recipients 에 담는다', async () => {
    const e1 = await signup(env.baseUrl, 's16e');
    const f1 = await signup(env.baseUrl, 's16f');
    // S16 (BLOCKER fix-forward): 전역 그룹은 각 멤버가 개설자의 친구여야 한다.
    await makeFriends(env.baseUrl, alice, e1);
    await makeFriends(env.baseUrl, alice, f1);

    const received: Array<Record<string, unknown>> = [];
    const handler = (e: Record<string, unknown>): void => {
      received.push(e);
    };
    emitter.on(DM_CREATED, handler);

    const res = await request(env.baseUrl)
      .post('/me/dms/groups')
      .set(bearer(alice.accessToken))
      .send({ memberIds: [e1.userId, f1.userId] });
    expect(res.status).toBe(201);
    const channelId = res.body.channelId as string;

    await env.dispatcher.drain();

    const ev = received.find((e) => (e as { channelId?: string }).channelId === channelId);
    expect(ev).toBeDefined();
    expect(ev!.isGroup).toBe(true);
    expect(ev!.recipients).toEqual(expect.arrayContaining([alice.userId, e1.userId, f1.userId]));

    emitter.off(DM_CREATED, handler);
  });
});
