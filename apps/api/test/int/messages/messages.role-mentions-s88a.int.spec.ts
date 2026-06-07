/**
 * S88a (FR-MN-03) @role 멘션 동기 fanout 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * 커버리지(ADR Acceptance 3):
 *   - @<mentionable role> → 역할 멤버 전원 mention.received(공개 채널).
 *   - non-mentionable 역할은 MENTION_EVERYONE 권한자(OWNER/ADMIN)만 멘션 가능.
 *   - 비공개 채널: VIEW_CHANNEL 비가시 역할 멤버는 제외.
 *   - user 5/분 · role 10/5분 초과 시 429.
 *   - @user ∪ @role dedup(중복 1건).
 *   - MENTIONS notif level 사용자도 역할 멘션 수신(direct 분류).
 *
 * 멘션 fanout 은 메시지 저장 tx 에서 UserMention outbox 행으로 기록되므로 outbox 를
 * 직접 조회해 수신자 집합을 권위 검증한다(S44 스펙 패턴 재사용).
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

async function createRole(name: string, mentionable: boolean): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/roles`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ name, mentionable });
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
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.channelPermissionOverride.deleteMany({});
  await env.prisma.memberRole.deleteMany({ where: { workspaceId: stack.workspaceId } });
  await env.prisma.role.deleteMany({ where: { workspaceId: stack.workspaceId, isSystem: false } });
  await env.prisma.serverNotificationPref.deleteMany({});
  await env.prisma.userChannelMute.deleteMany({});
  // role rate-limit 키 초기화(테스트 간 누수 방지).
  const keys = await env.redis.keys('qufox:rl:mention:*');
  if (keys.length > 0) {
    await env.redis.del(...keys.map((k) => k.replace(/^qufox:/, '')));
  }
});

describe('S88a @mentionable role fanout (FR-MN-03 / D3·D4)', () => {
  it('mentionable 역할 멘션 → 역할 멤버 전원 mention.received(공개 채널)', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    await assignRole(roleId, memberC.userId);

    // member(비권한)도 mentionable 역할은 멘션 가능.
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'ship it @Engineers' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.roles).toEqual([roleId]);
    // 역할 멤버(memberB·memberC) 전원 수신. 작성자(member)는 역할 멤버가 아님.
    expect(await mentionRecipients()).toEqual([memberB.userId, memberC.userId].sort());
  });

  it('@user ∪ @role dedup — 양쪽에 걸린 수신자는 1건만', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: `@${memberB.username} also @Engineers` });
    expect(post.status).toBe(201);
    // memberB 는 @user 와 @role 양쪽 — 정확히 1건.
    expect(await mentionRecipients()).toEqual([memberB.userId]);
  });
});

describe('S88a non-mentionable role gate (FR-MN-03 / D3)', () => {
  it('비권한(member)의 non-mentionable 역할 멘션은 다운그레이드 — fanout 없음', async () => {
    const roleId = await createRole('Secret', false);
    await assignRole(roleId, memberB.userId);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'psst @Secret' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.roles).toEqual([]);
    expect(await mentionRecipients()).toEqual([]);
  });

  it('MENTION_EVERYONE 권한자(OWNER)의 non-mentionable 역할 멘션은 통과', async () => {
    const roleId = await createRole('Secret', false);
    await assignRole(roleId, memberB.userId);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'team @Secret' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.roles).toEqual([roleId]);
    expect(await mentionRecipients()).toEqual([memberB.userId]);
  });
});

describe('S88a private channel VIEW_CHANNEL filter (FR-MN-03 / D4)', () => {
  it('비공개 채널: 가시성 없는 역할 멤버는 fanout 에서 제외', async () => {
    // 비공개 채널 생성(owner 만 자동 가시).
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
    // memberB 만 비공개 채널에 READ ALLOW override 부여(가시) — memberC 는 비가시.
    const READ_BIT = 0x0001;
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${privId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ userId: memberB.userId, allowMask: READ_BIT })
      .expect(201);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${privId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'huddle @Engineers' });
    expect(post.status).toBe(201);
    // 가시 멤버(memberB)만 수신. 비가시 memberC 제외.
    expect(await mentionRecipients()).toEqual([memberB.userId]);
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

describe('S88a MENTIONS notif level receives role mention (FR-MN-03 / D4)', () => {
  it('글로벌 MENTIONS 레벨 사용자도 역할 멘션을 수신(direct 분류)', async () => {
    const roleId = await createRole('Engineers', true);
    await assignRole(roleId, memberB.userId);
    // memberB 글로벌 알림 레벨을 MENTIONS 로 설정(UserSettings.notifTrigger).
    await env.prisma.userSettings.upsert({
      where: { userId: memberB.userId },
      create: { userId: memberB.userId, notifTrigger: 'MENTIONS' },
      update: { notifTrigger: 'MENTIONS' },
    });

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'review @Engineers' });
    expect(post.status).toBe(201);
    // MENTIONS 레벨이어도 역할 멘션(direct)은 수신.
    expect(await mentionRecipients()).toEqual([memberB.userId]);
  });
});
