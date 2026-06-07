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
import {
  MsgIntEnv,
  ORIGIN,
  bearer,
  seedMessageStack,
  signup,
  setupMsgIntEnv,
  waitForMentionBroadcastDrain,
} from './helpers';
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
  // S88b 게이트 negative 케이스가 차단 관계(Friendship BLOCKED)를 seed 하므로 매 테스트
  // 시작 시 비워 테스트 간 누수를 막는다(block 케이스가 후속 케이스에 새지 않게).
  await env.prisma.friendship.deleteMany({});
  // S88a 이관 케이스(MENTIONS-level direct)가 UserSettings.notifTrigger 를 변경하므로 초기화.
  await env.prisma.serverNotificationPref.deleteMany({});
  await env.prisma.userSettings.deleteMany({
    where: { userId: { in: [memberB.userId, memberC.userId] } },
  });
  // mention(user/role 멘션) + role:mutate(createRole/assignRole 엔드포인트) rate-limit 키를
  // 매 테스트 리셋한다. 공유 stack(beforeAll) 에서 테스트마다 createRole/assignRole 을 반복하므로
  // role:mutate:ws 슬라이딩 윈도가 누적돼 후속 테스트가 429 로 깨지는 것을 막는다.
  const keys = await env.redis.keys('qufox:rl:*');
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

// S88a 에서 이관된 fanout(recipients) 케이스. @role fanout 이 async 로 옮겨졌으므로
// send 응답이 아니라 워커 drain 후 MentionRecord/outbox 를 권위 단언한다(중복 제거).
describe('S88b @role fanout — migrated from S88a (FR-MN-03 / D3·D4)', () => {
  it('MENTION_EVERYONE 권한자(OWNER)의 non-mentionable 역할 멘션 → 게이트 통과 후 fanout', async () => {
    const roleId = await createRole('Secret', false);
    await assignRole(roleId, memberB.userId);

    const msgId = await postMessage(stack.owner.accessToken, stack.channelId, 'team @Secret');
    await waitForMentionBroadcastDrain(env.mentionBroadcastQueue);
    await waitForRecords(msgId, 1);

    // OWNER 가 non-mentionable 역할을 멘션하면 게이트 통과 → 워커가 역할 멤버(memberB) fanout.
    expect(await recordTargets(msgId)).toEqual([memberB.userId]);
    expect(await outboxTargets(msgId)).toEqual([memberB.userId]);
  });

  it('글로벌 MENTIONS 레벨 사용자도 역할 멘션을 수신(direct 분류)', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    // memberB 글로벌 알림 레벨을 MENTIONS 로 설정(UserSettings.notifTrigger).
    await env.prisma.userSettings.upsert({
      where: { userId: memberB.userId },
      create: { userId: memberB.userId, notifTrigger: 'MENTIONS' },
      update: { notifTrigger: 'MENTIONS' },
    });

    const msgId = await postMessage(stack.owner.accessToken, stack.channelId, 'review @Engineers');
    await waitForMentionBroadcastDrain(env.mentionBroadcastQueue);
    await waitForRecords(msgId, 1);

    // MENTIONS 레벨이어도 역할 멘션(direct)은 수신.
    expect(await recordTargets(msgId)).toEqual([memberB.userId]);
    expect(await outboxTargets(msgId)).toEqual([memberB.userId]);
  });

  it('@user ∪ @role cross-path dedup — 양쪽에 걸린 수신자는 정확히 1건(회귀 가드)', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);

    // memberB 는 @user(동기 role=false)와 @role(async role=true) 양쪽에 걸린다. 워커가 직접
    // @user 수신자를 expand 에서 제외해야(cross-path dedup) mention.received 가 정확히 1건이다.
    const msgId = await postMessage(
      stack.member.accessToken,
      stack.channelId,
      `@${memberB.username} also @Engineers`,
    );
    // 동기 @user outbox 1건은 즉시. async @role 잡까지 drain 한 뒤 회귀를 단언한다.
    await waitForMentionBroadcastDrain(env.mentionBroadcastQueue);
    // 잠시 더 대기해 워커가 (잘못) 두 번째 outbox 를 쓰지 않음을 확인.
    await new Promise((r) => setTimeout(r, 300));

    // 정확히 1건(2건이면 cross-dedup 회귀). @role MentionRecord 도 0(직접 멘션 수신자 제외).
    expect(await outboxTargets(msgId)).toEqual([memberB.userId]);
    expect(await recordTargets(msgId)).toEqual([]);
  });
});

// ★F1 (BLOCKER) end-to-end 가드: 워커가 동기 send 경로와 동일한 per-recipient 게이트
// (block/mute/NotifLevel)를 재적용함을 실 Postgres+Redis+실 워커 drain 으로 증명한다.
// 종전 워커는 게이트를 빠뜨려 차단/뮤트/NOTHING 역할멤버에게도 @role 알림이 누출됐다
// (block 누출은 FR-PS-14 보안 회귀). 각 케이스: @mentionable 역할에 memberB·memberC 둘
// 다 배정 → memberB 에만 게이트 조건 설정 → 작성자(stack.member)가 @Role 멘션 → drain.
// 단언: 대조군 memberC 는 정상 1행(MentionRecord + mention.received outbox) 수신 ─ 전체
// fanout 실패가 아니라 "게이트만 제외" ─ 반면 memberB 는 0행/0건(게이트로 차단).
describe('S88b worker per-recipient gate negative guards (F1 / ★BLOCKER · FR-PS-14)', () => {
  /**
   * @mentionable 역할에 memberB·memberC 를 배정하고 작성자(stack.member)가 그 역할을 멘션,
   * 워커 drain 까지 마친 뒤 messageId 를 돌려준다. 대조군 memberC 가 1행 쓰일 때까지 대기하고
   * (waitForRecords 1), 게이트로 막힌 memberB 가 뒤늦게 추가되지 않음을 확인할 여유도 둔다.
   */
  async function postRoleMentionAndDrain(): Promise<{ msgId: string; roleId: string }> {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    await assignRole(roleId, memberC.userId);

    const msgId = await postMessage(stack.member.accessToken, stack.channelId, 'ping @Engineers');
    await waitForMentionBroadcastDrain(env.mentionBroadcastQueue);
    // 대조군(memberC)은 게이트를 통과하므로 최소 1행이 쓰여야 한다.
    await waitForRecords(msgId, 1);
    // 게이트로 막힌 memberB 가 뒤늦게(잡 후속 처리) 추가되지 않음을 확인할 여유.
    await new Promise((r) => setTimeout(r, 400));
    return { msgId, roleId };
  }

  it('① 차단(BLOCKED Friendship) 역할멤버 제외 — memberB 0, 대조군 memberC 1 (FR-PS-14 보안)', async () => {
    // memberB 가 작성자(stack.member)를 차단(피차단 방향: requesterId=memberB → author).
    // 게이트는 작성자↔수신자 어느 방향이든 BLOCKED 면 제외해야 한다.
    await env.prisma.friendship.create({
      data: {
        requesterId: memberB.userId,
        addresseeId: stack.member.userId,
        status: 'BLOCKED',
      },
    });

    const { msgId } = await postRoleMentionAndDrain();

    // 차단 관계 memberB 는 누출 0(MentionRecord 행 0 + mention.received outbox 0건).
    expect(await recordTargets(msgId)).toEqual([memberC.userId]);
    expect(await outboxTargets(msgId)).toEqual([memberC.userId]);
  });

  it('② 채널 뮤트(UserChannelMute isMuted) 역할멤버 제외 — memberB 0, 대조군 memberC 1', async () => {
    // memberB 가 해당 채널을 영구 뮤트(isMuted=true · mutedUntil null). 활성 뮤트로 제외.
    await env.prisma.userChannelMute.create({
      data: {
        userId: memberB.userId,
        channelId: stack.channelId,
        isMuted: true,
        mutedUntil: null,
      },
    });

    const { msgId } = await postRoleMentionAndDrain();

    expect(await recordTargets(msgId)).toEqual([memberC.userId]);
    expect(await outboxTargets(msgId)).toEqual([memberC.userId]);
  });

  it('③ 글로벌 NotifLevel=NOTHING 역할멤버 제외 — memberB 0, 대조군 memberC 1', async () => {
    // memberB 글로벌 알림 레벨 NOTHING(UserSettings.notifTrigger). NOTHING 은 direct
    // (역할 멘션)도 차단한다(MENTIONS 와 달리 통과 안 함 — 기존 MENTIONS 케이스의 대비).
    await env.prisma.userSettings.upsert({
      where: { userId: memberB.userId },
      create: { userId: memberB.userId, notifTrigger: 'NOTHING' },
      update: { notifTrigger: 'NOTHING' },
    });

    const { msgId } = await postRoleMentionAndDrain();

    expect(await recordTargets(msgId)).toEqual([memberC.userId]);
    expect(await outboxTargets(msgId)).toEqual([memberC.userId]);
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
        parentMessageId: null,
        gatedRoleIds: [roleId],
        syncNotifiedUserIds: [],
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
