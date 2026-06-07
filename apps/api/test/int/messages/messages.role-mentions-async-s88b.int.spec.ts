/**
 * S88b (FR-MN-03 / FR-MN-19) @role 멘션 async fanout 통합 검증 — 실 Postgres + Redis
 * (testcontainer) + 실 mention-broadcast BullMQ 워커(in-process · AppModule 부팅으로 활성).
 *
 * 커버리지(ADR Acceptance · B1·B2·B3·B4):
 *   - @<mentionable role> → 잡 enqueue → 워커 처리 → 공개 채널 역할 멤버 전원 MentionRecord
 *     행 + mention.received outbox(기존 subscriber 경로로 흐름).
 *   - 비공개 채널 VIEW_CHANNEL 비가시 역할 멤버는 MentionRecord/outbox 미생성(skip).
 *   - 멱등: 동일 잡 2회 처리 → MentionRecord 1행/recipient · outbox 1건/recipient(신규분만).
 *
 * 워커 drain 대기: OutboxDispatcher 폴링은 헬퍼가 멈추지만(WS 자동발행 억제) BullMQ 워커는
 * 활성이므로, MentionRecord 행이 나타날 때까지 폴링한다. 검증은 outbox/MentionRecord 행을
 * 직접 조회해 권위적으로 한다(S88a 패턴 재사용 · dispatcher 무관).
 *
 * ★S88a int 헬퍼 교훈 적용: createRole 은 명시 position(낮은 값) 부여(FR-RM04 가드 회피),
 * beforeEach 의 MemberRole 정리는 시스템 역할 보존(role:{isSystem:false} 필터).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';
import { MentionBroadcastProcessor } from '../../../src/queue/mention-broadcast.processor';
import type { MentionBroadcastJobData } from '../../../src/queue/mention-broadcast-queue.constants';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
let memberB: Awaited<ReturnType<typeof signup>>;
let memberC: Awaited<ReturnType<typeof signup>>;
let processor: MentionBroadcastProcessor;

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

let rolePositionSeq = 10;
async function createRole(name: string, mentionable: boolean): Promise<string> {
  const position = rolePositionSeq;
  rolePositionSeq += 10;
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/roles`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ name, mentionable, position });
  if (res.status !== 201) throw new Error(`createRole ${name}: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function assignRole(roleId: string, userId: string): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/roles/assign`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ roleId, userId });
  if (res.status >= 300) throw new Error(`assignRole: ${res.status} ${res.text}`);
}

async function postMessage(token: string, channelId: string, content: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`postMessage: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

/** MentionRecord 의 targetId 집합(특정 메시지). */
async function recordTargets(messageId: string): Promise<string[]> {
  const rows = await env.prisma.mentionRecord.findMany({
    where: { messageId, targetType: 'USER' },
    select: { targetId: true },
  });
  return rows.map((r) => r.targetId).sort();
}

/** 특정 메시지의 mention.received outbox 수신자(aggregateId) 집합. */
async function outboxTargets(messageId: string): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true, payload: true },
  });
  return rows
    .filter((r) => (r.payload as { messageId?: string } | null)?.messageId === messageId)
    .map((r) => r.aggregateId)
    .sort();
}

/** 워커가 MentionRecord 를 expected 개수만큼 쓸 때까지 폴링한다(잡 drain 대기). */
async function waitForRecords(messageId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const n = (await recordTargets(messageId)).length;
    if (n >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${expected} MentionRecord(s) on msg=${messageId}, got ${n}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

function fakeJob(data: MentionBroadcastJobData, attemptsMade = 1): Job<MentionBroadcastJobData> {
  return { data, attemptsMade, opts: { attempts: 3 } } as Job<MentionBroadcastJobData>;
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  memberB = await signup(env.baseUrl, 'rab');
  memberC = await signup(env.baseUrl, 'rac');
  await joinWorkspace(memberB.accessToken);
  await joinWorkspace(memberC.accessToken);
  processor = env.app.get(MentionBroadcastProcessor);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.mentionRecord.deleteMany({});
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.channelPermissionOverride.deleteMany({});
  await env.prisma.memberRole.deleteMany({
    where: { workspaceId: stack.workspaceId, role: { isSystem: false } },
  });
  await env.prisma.role.deleteMany({ where: { workspaceId: stack.workspaceId, isSystem: false } });
  await env.prisma.userChannelMute.deleteMany({});
  const keys = await env.redis.keys('qufox:rl:mention:*');
  if (keys.length > 0) {
    await env.redis.del(...keys.map((k) => k.replace(/^qufox:/, '')));
  }
});

describe('S88b @role async fanout via mention-broadcast worker (FR-MN-19 · B1·B2)', () => {
  it('enqueues + worker writes MentionRecord + mention.received for all role members (public)', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    await assignRole(roleId, memberC.userId);

    const msgId = await postMessage(
      stack.member.accessToken,
      stack.channelId,
      'ship it @Engineers',
    );
    await waitForRecords(msgId, 2);

    // 공개 채널 역할 멤버 전원(memberB·memberC). 작성자(member)는 역할 멤버 아님.
    expect(await recordTargets(msgId)).toEqual([memberB.userId, memberC.userId].sort());
    // mention.received outbox 가 기존 subscriber 경로로 흐를 수 있게 신규분만 기록됨.
    expect(await outboxTargets(msgId)).toEqual([memberB.userId, memberC.userId].sort());
  });
});

describe('S88b private channel VIEW_CHANNEL re-check at job time (FR-MN-03 / B1)', () => {
  it('skips invisible role members on a private channel (no record / no outbox)', async () => {
    const ch = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ name: `priv-${Date.now().toString(36).slice(-6)}`, type: 'TEXT', isPrivate: true });
    expect(ch.status).toBe(201);
    const privId = ch.body.id as string;

    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    await assignRole(roleId, memberC.userId);
    // memberB 만 비공개 채널 READ ALLOW(가시) — memberC 비가시.
    const READ_BIT = 0x0001;
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${privId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ userId: memberB.userId, allowMask: READ_BIT })
      .expect(201);

    const msgId = await postMessage(stack.owner.accessToken, privId, 'huddle @Engineers');
    await waitForRecords(msgId, 1);
    // 잠시 더 대기해 비가시 멤버가 뒤늦게 추가되지 않음을 확인.
    await new Promise((r) => setTimeout(r, 400));

    expect(await recordTargets(msgId)).toEqual([memberB.userId]);
    expect(await outboxTargets(msgId)).toEqual([memberB.userId]);
  });
});

describe('S88b idempotency — re-processing the same job (FR-MN-19 / B4)', () => {
  it('a second worker pass inserts no new MentionRecord and emits no extra outbox', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    await assignRole(roleId, memberC.userId);

    const msgId = await postMessage(stack.owner.accessToken, stack.channelId, 'review @Engineers');
    await waitForRecords(msgId, 2);

    const recordsBefore = await recordTargets(msgId);
    const outboxBefore = await outboxTargets(msgId);
    expect(recordsBefore).toEqual([memberB.userId, memberC.userId].sort());
    expect(outboxBefore).toEqual([memberB.userId, memberC.userId].sort());

    // 동일 잡을 워커에 직접 한 번 더 통과시킨다(재시도/재시작 재처리 시뮬레이션).
    const msgRow = await env.prisma.message.findUniqueOrThrow({ where: { id: msgId } });
    await processor.process(
      fakeJob({
        messageId: msgId,
        channelId: stack.channelId,
        workspaceId: stack.workspaceId,
        actorId: stack.owner.userId,
        gatedRoleIds: [roleId],
        snippet: 'review @Engineers',
        everyone: false,
        here: false,
        createdAt: msgRow.createdAt.toISOString(),
      }),
    );

    // 멱등: MentionRecord 행 그대로(recipient 당 1행) · outbox 추가 0.
    expect(await recordTargets(msgId)).toEqual(recordsBefore);
    expect(await outboxTargets(msgId)).toEqual(outboxBefore);
  });
});
