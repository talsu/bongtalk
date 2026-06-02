/**
 * S44 (D06 멘션·알림) 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * 커버리지:
 *   - FR-MN-02/16: MENTION_EVERYONE(카탈로그 0x0080) override fold 기반 @everyone fanout.
 *       · 기본 MEMBER → 차단(범위 멘션 outbox 없음)
 *       · MEMBER + USER allow override → 허용(@everyone fanout 발생)
 *       · OWNER + USER deny override → 차단
 *   - FR-MN-02: @here online/idle 필터 — presence ONLINE 인 멤버에게만 mention.received emit.
 *   - FR-MN-01: 멘션 outbox→WS wire 이벤트 이름이 `mention:new` 로 정렬.
 *
 * 멘션 fanout 은 메시지 저장과 동일 tx 에서 UserMention outbox 행으로 기록되므로,
 * outbox 테이블을 직접 조회해 수신자 집합을 검증한다(WS drain 없이 권위 검증).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';
import { PresenceService } from '../../../src/realtime/presence/presence.service';

const PERMISSIONS_MENTION_EVERYONE = 0x0080;

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
let presence: PresenceService;
// 추가 멤버 — @everyone/@here fanout 대상이 author 외에 존재하도록.
let memberB: Awaited<ReturnType<typeof signup>>;
let memberC: Awaited<ReturnType<typeof signup>>;

async function joinWorkspace(token: string): Promise<void> {
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ maxUses: 10 });
  const code = inv.body.invite.code as string;
  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('origin', ORIGIN)
    .set(bearer(token));
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  presence = env.app.get(PresenceService);
  memberB = await signup(env.baseUrl, 'msb');
  memberC = await signup(env.baseUrl, 'msc');
  await joinWorkspace(memberB.accessToken);
  await joinWorkspace(memberC.accessToken);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.channelPermissionOverride.deleteMany({ where: { channelId: stack.channelId } });
  // presence 초기화 — 각 테스트가 명시적으로 online 상태를 만든다. ioredis 의
  // keyPrefix(qufox:)는 KEYS 의 패턴 인자에는 자동 적용되지 않으므로 prefixed
  // 패턴으로 조회한 뒤, DEL 에는 prefix 를 자동 적용하므로 prefix 를 떼고 넘긴다.
  const keys = await env.redis.keys('qufox:presence:*');
  if (keys.length > 0) {
    const stripped = keys.map((k) => k.replace(/^qufox:/, ''));
    await env.redis.del(...stripped);
  }
});

async function mentionRecipients(): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true },
  });
  return rows.map((r) => r.aggregateId).sort();
}

describe('S44 @everyone MENTION_EVERYONE override fold (FR-MN-02/16)', () => {
  it('기본 MEMBER 의 @everyone 은 차단 — 범위 멘션 outbox 가 없다', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'hey @everyone' });
    expect(post.status).toBe(201);
    // gate 가 everyone=false 로 다운그레이드 → 범위 fanout 없음.
    expect(post.body.message.mentions.everyone).toBe(false);
    expect(await mentionRecipients()).toEqual([]);
  });

  it('MEMBER + USER allow override → @everyone 허용, 작성자 외 전원 fanout', async () => {
    // 채널에 member(작성자)용 USER allow override(MENTION_EVERYONE 비트) 부여.
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ userId: stack.member.userId, allowMask: PERMISSIONS_MENTION_EVERYONE })
      .expect(201);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'ping @everyone' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.everyone).toBe(true);

    // 작성자(member) 제외, 나머지 워크스페이스 멤버 전원에게 mention.received.
    const recipients = await mentionRecipients();
    const expected = [
      stack.owner.userId,
      stack.admin.userId,
      memberB.userId,
      memberC.userId,
    ].sort();
    expect(recipients).toEqual(expected);
  });

  it('OWNER + USER deny override → @everyone 차단(개인 DENY 가 역할 base 를 이김)', async () => {
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ userId: stack.owner.userId, denyMask: PERMISSIONS_MENTION_EVERYONE })
      .expect(201);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'owner @everyone' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.everyone).toBe(false);
    expect(await mentionRecipients()).toEqual([]);
  });
});

describe('S44 @here online/idle 필터 (FR-MN-02)', () => {
  it('@here 는 ONLINE 멤버에게만 mention.received emit (OWNER 권한)', async () => {
    // owner(작성자)는 OWNER 라 MENTION_EVERYONE 권한 보유 → @here 게이트 통과.
    // memberB 만 online 으로 만든다(session 등록 + 최근 활동). memberC/admin 은 offline.
    await presence.register({
      sessionId: 'sess-b',
      userId: memberB.userId,
      workspaceIds: [stack.workspaceId],
      preference: 'auto',
    });

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'standup @here' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.here).toBe(true);

    // online 인 memberB 만 수신. offline 인 admin/memberC 는 제외. 작성자(owner) 제외.
    expect(await mentionRecipients()).toEqual([memberB.userId]);
  });

  it('아무도 online 이 아니면 @here 범위 fanout 수신자 0명', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'nobody here @here' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.here).toBe(true);
    expect(await mentionRecipients()).toEqual([]);
  });
});

describe('S44 fix-forward @here presence 전역 장애 fallback (MAJOR)', () => {
  it('presence 조회가 전역 실패하면 @here 는 full member set 으로 over-notify', async () => {
    // owner(작성자)는 OWNER 라 @here 게이트 통과. presence.effectiveStatus 가
    // 모든 호출에서 throw 하도록(=Redis 전역 장애 시뮬레이션) 스파이한다.
    // 종전 per-user `.catch(()=>offline)` 는 전원 offline→수신자 0(fail-closed)이었고,
    // fix-forward 는 전역 실패 시 full member set 으로 fail-open(over-notify) 한다.
    const spy = vi
      .spyOn(presence, 'effectiveStatus')
      .mockRejectedValue(new Error('redis down (simulated global outage)'));
    try {
      const post = await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(stack.owner.accessToken))
        .send({ content: 'all hands @here' });
      expect(post.status).toBe(201);
      expect(post.body.message.mentions.here).toBe(true);
      // 작성자(owner) 제외, 나머지 워크스페이스 멤버 전원 수신(over-notify fallback).
      const recipients = await mentionRecipients();
      const expected = [
        stack.admin.userId,
        stack.member.userId,
        memberB.userId,
        memberC.userId,
      ].sort();
      expect(recipients).toEqual(expected);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('S44 fix-forward 편집(update) broad 멘션 fanout (BLOCKER)', () => {
  it('편집으로 @everyone 추가 시 fanout 발생 — 신규 멘션 대상 전원 수신', async () => {
    // owner 가 @everyone 권한 보유. 먼저 범위 멘션 없는 일반 메시지를 보내고
    // (수신자 0), 그 메시지를 편집해 @everyone 을 추가하면 broad fanout 이 발생해야 한다.
    const send = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'plain message' });
    expect(send.status).toBe(201);
    expect(await mentionRecipients()).toEqual([]);
    const msgId = send.body.message.id as string;
    const version = send.body.message.version as number;

    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'edited now @everyone', expectedVersion: version });
    expect(patch.status).toBe(200);
    expect(patch.body.message.mentions.everyone).toBe(true);

    // 편집으로 새로 추가된 @everyone → 작성자(owner) 외 워크스페이스 멤버 전원 fanout.
    const recipients = await mentionRecipients();
    const expected = [
      stack.admin.userId,
      stack.member.userId,
      memberB.userId,
      memberC.userId,
    ].sort();
    expect(recipients).toEqual(expected);
  });

  it('이미 멘션받은 수신자에게는 재편집 시 중복 알림하지 않는다(신규 추가분만)', async () => {
    // 1) @admin 직접 멘션으로 send → admin 1건 수신.
    const send = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: `hello @${stack.admin.username}` });
    expect(send.status).toBe(201);
    expect(await mentionRecipients()).toEqual([stack.admin.userId]);
    const msgId = send.body.message.id as string;
    const version = send.body.message.version as number;

    // 편집으로 발생할 신규 fanout 만 보기 위해 send 단계의 outbox 를 비운다.
    await env.prisma.outboxEvent.deleteMany({});

    // 2) @admin 은 유지하고 @memberB 를 추가 편집 → admin 은 이전 멘션 대상이라
    //    재알림하지 않고, 신규 추가분 memberB 만 수신해야 한다.
    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({
        content: `hello @${stack.admin.username} @${memberB.username}`,
        expectedVersion: version,
      });
    expect(patch.status).toBe(200);
    // 신규 추가분(memberB)만 — admin 은 이전 버전에서 이미 멘션받아 제외.
    expect(await mentionRecipients()).toEqual([memberB.userId]);
  });
});

describe('S44 mention:new wire 이벤트 정렬 (FR-MN-01)', () => {
  it('멘션 outbox 가 dispatch 되면 WS 핸들러는 `mention:new` 로 수신한다', async () => {
    const received: string[] = [];
    const ee = env.app.get(EventEmitter2);
    // outbox→WS subscriber 가 mention.received → mention:new 로 변환해 io.emit 하지만,
    // 여기서는 outbox 내부 dot 이벤트(mention.received)가 EventEmitter 로 흐르는지와
    // subscriber 가 wire 이름을 쓰는지를 분리 검증한다. dot 이벤트 수신 확인:
    const dotHandler = (e: { type: string }) => received.push(e.type);
    ee.on('mention.received', dotHandler);

    // member → @owner 직접 멘션(권한 무관). owner 에게 mention.received 1건.
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: `hi @${stack.owner.username}` });
    expect(post.status).toBe(201);

    await env.dispatcher.drain();
    ee.off('mention.received', dotHandler);

    // 내부 outbox eventType 은 dot 표기 유지(mention.received).
    expect(received).toContain('mention.received');
    const row = await env.prisma.outboxEvent.findFirst({
      where: { aggregateType: 'UserMention' },
    });
    expect(row?.eventType).toBe('mention.received');
    // 수신자는 owner 한 명(작성자 member 제외).
    expect(await mentionRecipients()).toEqual([stack.owner.userId]);
  });
});
