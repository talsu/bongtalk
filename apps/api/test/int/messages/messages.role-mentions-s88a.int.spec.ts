/**
 * S88a (FR-MN-03) @role 멘션 send-time 동기 로직 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * ★범위(S88b fix-forward 로 분리): S88b 가 @role fanout 을 동기 outbox → mention-broadcast
 * BullMQ 워커로 이관했다. 따라서 이 스펙은 **메시지 전송 시점에 동기로 끝나는 로직만** 검증한다:
 *   - mentionable / non-mentionable 게이트의 응답 계약(`mentions.roles`).
 *   - non-mentionable 다운그레이드(비권한 멤버): 게이트가 역할을 떨궈 fanout 자체가 일어나지
 *     않음(roles=[] · 큐 enqueue 없음 · 수신자 0). 이것은 send 시점에 완결되는 동기 검증이다.
 *   - dual rate-limit(user 5/분 · role 10/5분) 429.
 *
 * 실제 @role fanout(역할 멤버 expand · VIEW_CHANNEL 재검증 · 수신자 집합 · @user∪@role
 * cross-path dedup · MENTIONS-level direct 수신)은 워커 drain 이 필요하므로
 * `messages.role-mentions-async-s88b.int.spec.ts` 로 이관했다(중복 제거 · async 모델 일관).
 *
 * 동기 검증 단언은 응답 본문(mentions.roles)·HTTP 상태(429)만 본다 — 워커가 비동기로 쓰는
 * MentionRecord/outbox 행은 보지 않으므로 drain 불요다.
 *
 * ★S88a int 헬퍼 교훈: createRole 은 명시 position(낮은 값) 부여(FR-RM04 가드 회피),
 * beforeEach 의 MemberRole 정리는 시스템 역할 보존(role:{isSystem:false} 필터).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
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

// 커스텀 역할 position 은 액터(OWNER, top=500) 최고 position 미만이어야 한다(FR-RM04 가드).
// position 을 명시하지 않으면 nextCustomPosition 기본값이 가드에 걸릴 수 있어, roles.int.spec
// 과 동일하게 명시적으로 낮은(서로 다른) position 을 부여한다. mention 게이트 검증은 position 과
// 무관하므로 단조 증가 값(10,20,…)으로 충분하다.
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

/** 특정 메시지의 mention.received outbox 수신자(aggregateId) 집합 — 동기 경로 단언용. */
async function mentionRecipients(): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true },
  });
  return rows.map((r) => r.aggregateId).sort();
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  memberB = await signup(env.baseUrl, 'rmb');
  memberC = await signup(env.baseUrl, 'rmc');
  await joinWorkspace(memberB.accessToken);
  await joinWorkspace(memberC.accessToken);
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
  // 커스텀(비시스템) 역할 할당만 정리한다. 시스템 MemberRole(owner=OWNER/500 등)을 지우면
  // computeActorContext 의 topPosition 이 0 이 되어 이후 createRole 이 FR-RM04 가드(403)에
  // 걸린다(원 헬퍼 버그). role.deleteMany(isSystem:false) 가 cascade 로 커스텀 MemberRole 을
  // 지우지만, 명시적으로 비시스템 역할 할당만 선삭제해 의도를 분명히 한다.
  await env.prisma.memberRole.deleteMany({
    where: { workspaceId: stack.workspaceId, role: { isSystem: false } },
  });
  await env.prisma.role.deleteMany({ where: { workspaceId: stack.workspaceId, isSystem: false } });
  await env.prisma.serverNotificationPref.deleteMany({});
  await env.prisma.userChannelMute.deleteMany({});
  // role rate-limit 키 초기화(테스트 간 누수 방지).
  const keys = await env.redis.keys('qufox:rl:mention:*');
  if (keys.length > 0) {
    await env.redis.del(...keys.map((k) => k.replace(/^qufox:/, '')));
  }
});

describe('S88a @role mention send-time gate response (FR-MN-03 / D3)', () => {
  it('mentionable 역할은 비권한 멤버도 멘션 가능 — 응답 mentions.roles 에 포함(fanout 은 async)', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    await assignRole(roleId, memberC.userId);

    // member(비권한)도 mentionable 역할은 멘션 가능. 실제 수신자 fanout 은 mention-broadcast
    // 워커가 비동기로 처리하므로 여기서는 send 응답 계약만 본다(수신자 단언은 S88b 스펙).
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'ship it @Engineers' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.roles).toEqual([roleId]);
  });

  it('비권한(member)의 non-mentionable 역할 멘션은 다운그레이드 — roles=[] · 동기 수신자 0', async () => {
    const roleId = await createRole('Secret', false);
    await assignRole(roleId, memberB.userId);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'psst @Secret' });
    expect(post.status).toBe(201);
    // 게이트가 역할을 떨궈 fanout 자체가 일어나지 않는다(큐 enqueue 없음 · 동기 send 에서 완결).
    expect(post.body.message.mentions.roles).toEqual([]);
    expect(await mentionRecipients()).toEqual([]);
  });

  it('MENTION_EVERYONE 권한자(OWNER)의 non-mentionable 역할 멘션은 게이트 통과 — roles 에 포함', async () => {
    const roleId = await createRole('Secret', false);
    await assignRole(roleId, memberB.userId);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'team @Secret' });
    expect(post.status).toBe(201);
    // 게이트 통과(응답 계약). 실제 fanout 수신자(memberB)는 워커 drain 후 단언 — S88b 스펙.
    expect(post.body.message.mentions.roles).toEqual([roleId]);
  });
});

describe('S88a dual rate-limit (FR-MN-03 / D5)', () => {
  it('동일 역할 멘션 5분 내 10회 초과 시 429', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);

    let last = 0;
    // user 5/분 한도가 role 한도보다 먼저 걸리므로, 6번째부터 user 한도로 429 가 난다.
    for (let i = 0; i < 7; i++) {
      const res = await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(stack.owner.accessToken))
        .send({ content: `loop ${i} @Engineers` });
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
  });
});
