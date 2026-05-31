/**
 * S05 (FR-MSG-06 / FR-RC16) 실DB 통합 검증.
 *
 * 단위 테스트가 전부 vi.fn() 스텁이라 편집 낙관잠금(409) / EditHistory 스냅샷
 * / ring buffer(cap 10) / history 권한 게이트를 실제 Postgres 로 증명한 적이
 * 없었습니다(handoff 0-1). 이 스펙이 testcontainers Postgres 위에서 네 가지를
 * 직접 검증합니다:
 *   1. 정상 편집 → version +1, EditHistory 에 편집 전 본문 스냅샷 1행.
 *   2. 동시/stale 편집 → 한쪽만 성공, 다른 쪽 MESSAGE_VERSION_CONFLICT(409)
 *      + details.current(현재 MessageDto, 채널 격리됨).
 *   3. 11회 편집 → ring buffer 가 정확히 10행 유지(가장 오래된 version 1개 evict).
 *   4. GET :msgId/history 권한 — 작성자 200 / OWNER·ADMIN 200 / 비작성자 멤버 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';
import type { Actor } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
// 비작성자 일반 멤버(권한 403 검증용) — seedMessageStack 의 member 는 작성자
// 역할로 쓰므로 두 번째 평멤버를 워크스페이스에 합류시킵니다.
let member2: Actor;
// 채널 격리(security HIGH-02) 검증용 두 번째 TEXT 채널.
let channel2Id: string;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);

  member2 = await signup(env.baseUrl, 'msm2');
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ maxUses: 10 });
  const code = inv.body.invite.code as string;
  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('origin', ORIGIN)
    .set(bearer(member2.accessToken));

  const ch2 = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ name: `edit-iso-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' });
  if (ch2.status !== 201) throw new Error(`channel2 create: ${ch2.status} ${ch2.text}`);
  channel2Id = ch2.body.id as string;
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // EditHistory 는 Message FK onDelete: Cascade 라 메시지 삭제 시 함께 정리되지만
  // 명시적으로 비워 잔여 행이 카운트에 새지 않게 합니다.
  await env.prisma.messageEditHistory.deleteMany({});
  await env.prisma.message.deleteMany({
    where: { channelId: { in: [stack.channelId, channel2Id] } },
  });
  const rlKeys = await env.redis.keys('rl:msg:*');
  if (rlKeys.length > 0) await env.redis.del(...rlKeys);
});

const base = () => `/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`;

async function send(token: string, content: string): Promise<{ id: string; version: number }> {
  const res = await request(env.baseUrl)
    .post(base())
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${res.text}`);
  return { id: res.body.message.id, version: res.body.message.version };
}

describe('S05 edit optimistic-lock + EditHistory (real Postgres)', () => {
  it('1) 정상 편집 → version +1, edited=true, EditHistory 에 편집 전 본문 1행', async () => {
    const { id, version } = await send(stack.member.accessToken, 'original body');
    expect(version).toBe(0);

    const patch = await request(env.baseUrl)
      .patch(`${base()}/${id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'edited body', expectedVersion: 0 });
    expect(patch.status).toBe(200);
    expect(patch.body.message.content).toBe('edited body');
    expect(patch.body.message.edited).toBe(true);
    expect(patch.body.message.version).toBe(1);

    const history = await env.prisma.messageEditHistory.findMany({
      where: { messageId: id },
      orderBy: { version: 'asc' },
    });
    expect(history).toHaveLength(1);
    // 스냅샷은 편집 전 상태 — version 0, 편집 전 본문.
    expect(history[0].version).toBe(0);
    expect(history[0].contentPlain).toBe('original body');
    expect(history[0].contentRaw).toBe('original body');
  });

  it('2a) stale expectedVersion → 409 MESSAGE_VERSION_CONFLICT + details.current(version 1)', async () => {
    const { id } = await send(stack.member.accessToken, 'v0');
    // 첫 편집 성공 → version 1.
    await request(env.baseUrl)
      .patch(`${base()}/${id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'v1', expectedVersion: 0 })
      .expect(200);

    // stale 스냅샷(여전히 expectedVersion 0)으로 재편집 → 409.
    const stale = await request(env.baseUrl)
      .patch(`${base()}/${id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'v1-conflict', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.errorCode).toBe('MESSAGE_VERSION_CONFLICT');
    expect(stale.body.details?.current?.id).toBe(id);
    expect(stale.body.details?.current?.version).toBe(1);
    // 격리: details.current 는 해당 채널의 행이어야 함(security HIGH-02).
    expect(stale.body.details?.current?.channelId).toBe(stack.channelId);
    // 충돌 편집은 적용되지 않았어야 함 — content 는 직전 성공값 그대로.
    expect(stale.body.details?.current?.content).toBe('v1');

    // 실패한 편집은 EditHistory 를 남기지 않음(성공 1회분만).
    const history = await env.prisma.messageEditHistory.findMany({ where: { messageId: id } });
    expect(history).toHaveLength(1);
  });

  it('2b) 동시 편집(둘 다 expectedVersion 0) → 정확히 한쪽 200, 다른 쪽 409', async () => {
    const { id } = await send(stack.member.accessToken, 'race-base');
    const fire = (content: string) =>
      request(env.baseUrl)
        .patch(`${base()}/${id}`)
        .set('origin', ORIGIN)
        .set(bearer(stack.member.accessToken))
        .send({ content, expectedVersion: 0 });

    const [a, b] = await Promise.all([fire('race-A'), fire('race-B')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const ok = a.status === 200 ? a : b;
    const conflict = a.status === 409 ? a : b;
    expect(ok.body.message.version).toBe(1);
    expect(conflict.body.errorCode).toBe('MESSAGE_VERSION_CONFLICT');
    expect(conflict.body.details?.current?.version).toBe(1);

    // 승자 1회분만 이력에 남음.
    const history = await env.prisma.messageEditHistory.findMany({ where: { messageId: id } });
    expect(history).toHaveLength(1);
  });

  it('2c) 채널 격리 — 다른 채널 라우트로 편집 시도 시 404, 누수 없음', async () => {
    const { id } = await send(stack.member.accessToken, 'isolated');
    // channel2 라우트로 channel1 메시지 편집 시도 → MessageAuthorGuard 가
    // {id, channelId} 스코핑으로 행을 못 찾아 404. details.current 누수 없음.
    const res = await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${channel2Id}/messages/${id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'cross-channel', expectedVersion: 0 });
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('MESSAGE_NOT_FOUND');
    expect(res.body.details).toBeUndefined();
  });

  it('3) 11회 편집 → ring buffer 정확히 10행 유지(가장 오래된 version 0 evict)', async () => {
    const { id } = await send(stack.member.accessToken, 'edit #0');
    // expectedVersion 은 매 편집 전 현재 version(0,1,...,10) — 11회 편집.
    for (let v = 0; v < 11; v++) {
      await request(env.baseUrl)
        .patch(`${base()}/${id}`)
        .set('origin', ORIGIN)
        .set(bearer(stack.member.accessToken))
        .send({ content: `edit #${v + 1}`, expectedVersion: v })
        .expect(200);
    }

    const history = await env.prisma.messageEditHistory.findMany({
      where: { messageId: id },
      orderBy: { version: 'asc' },
    });
    // 11회 편집이 version 0..10 스냅샷 11행을 만들지만 cap 10 으로 oldest(0) evict.
    expect(history).toHaveLength(10);
    const versions = history.map((h) => h.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(versions).not.toContain(0);

    // 메시지 자체 version 은 11.
    const finalMsg = await env.prisma.message.findUnique({ where: { id } });
    expect(finalMsg?.version).toBe(11);
  });

  // ── verify fix-forward (정적 리뷰 발견) ──────────────────────────────────

  it('동시 DELETE → 데이터 레이어가 직렬화, message.deleted 정확히 1회만 emit', async () => {
    // 정적 리뷰 HIGH: softDelete 가 update({where:{id}}) (deletedAt:null 가드
    // 없음)였을 때, 컨트롤러의 트랜잭션 밖 deletedAt 선검사를 둘 다 통과한
    // 동시/재시도 삭제가 양쪽 다 UPDATE+emit 해 중복 fanout + deletedAt 재기록을
    // 일으켰다. updateMany WHERE deletedAt:null + count 가드로 두 번째를 no-op 화.
    const { id } = await send(stack.member.accessToken, 'race-delete');
    const fire = () =>
      request(env.baseUrl)
        .delete(`${base()}/${id}`)
        .set('origin', ORIGIN)
        .set(bearer(stack.member.accessToken));
    const [a, b] = await Promise.all([fire(), fire()]);
    // 한쪽은 실제 삭제, 다른 쪽은 idempotent no-op — 둘 다 204.
    expect([a.status, b.status].sort()).toEqual([204, 204]);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message', eventType: 'message.deleted', aggregateId: id },
    });
    expect(events).toHaveLength(1);
  });

  it('편집 → message.updated outbox payload 가 edited:true + 새 version 전파', async () => {
    // 정적 리뷰 HIGH: nested MESSAGE_UPDATED payload 에 edited 가 없어, 편집 전
    // 캐시(edited:false)를 가진 다른 클라이언트가 REST refetch 전까지 (수정됨)
    // 뱃지를 못 봤다(디스패처가 부분 DTO 를 verbatim merge). payload 에 edited:true 적재.
    const { id } = await send(stack.member.accessToken, 'live-edit-base');
    await request(env.baseUrl)
      .patch(`${base()}/${id}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'live-edited', expectedVersion: 0 })
      .expect(200);

    const evt = await env.prisma.outboxEvent.findFirst({
      where: { aggregateType: 'Message', eventType: 'message.updated', aggregateId: id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(evt).toBeTruthy();
    const payload = evt!.payload as unknown as {
      message: { edited: boolean; version: number; editedAt: string };
    };
    expect(payload.message.edited).toBe(true);
    expect(payload.message.version).toBe(1);
    expect(payload.message.editedAt).toBeTruthy();
  });

  describe('4) GET :msgId/history 권한 게이트', () => {
    let msgId: string;
    beforeEach(async () => {
      const sent = await send(stack.member.accessToken, 'history-orig');
      msgId = sent.id;
      await request(env.baseUrl)
        .patch(`${base()}/${msgId}`)
        .set('origin', ORIGIN)
        .set(bearer(stack.member.accessToken))
        .send({ content: 'history-edited', expectedVersion: 0 })
        .expect(200);
    });

    const histUrl = () => `${base()}/${msgId}/history`;

    it('작성자(member) → 200 + version desc 이력', async () => {
      const res = await request(env.baseUrl).get(histUrl()).set(bearer(stack.member.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].version).toBe(0);
      expect(res.body.items[0].contentPlain).toBe('history-orig');
    });

    it('OWNER(모더레이터) → 200', async () => {
      const res = await request(env.baseUrl).get(histUrl()).set(bearer(stack.owner.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });

    it('ADMIN(모더레이터) → 200', async () => {
      const res = await request(env.baseUrl).get(histUrl()).set(bearer(stack.admin.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });

    it('비작성자 일반 멤버(member2) → 403 MESSAGE_NOT_AUTHOR', async () => {
      const res = await request(env.baseUrl).get(histUrl()).set(bearer(member2.accessToken));
      expect(res.status).toBe(403);
      expect(res.body.errorCode).toBe('MESSAGE_NOT_AUTHOR');
    });
  });
});
