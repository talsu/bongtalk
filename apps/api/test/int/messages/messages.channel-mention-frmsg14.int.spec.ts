/**
 * S94 (067 / FR-MSG-14) 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * Option B(별도 권한 비트): @channel/@here 는 MENTION_CHANNEL(0x2000, 기본 MEMBER
 * 허용) 권한으로, @everyone(MENTION_EVERYONE, OWNER/ADMIN 전용)과 분리됐다. + 서버
 * 측 대규모 범위 멘션 임계값 enforce(@everyone 채널 멤버수 ≥6 · @here/@channel ≥50).
 *
 * 커버리지(ADR Acceptance Criteria):
 *   - MEMBER 가 override 없이 @here/@channel → fanout 도달(strip 안 됨).
 *   - MEMBER 가 @everyone → strip(MENTION_EVERYONE base off 유지).
 *   - 채널 ROLE override DENY(MENTION_CHANNEL) → 해당 역할 MEMBER @channel 박탈.
 *   - 워크스페이스 멤버수 ≥6 @everyone + !bulkMentionConfirmed → 409(idempotencyKey 미소비).
 *   - 멤버수 ≥50 @channel + !bulkMentionConfirmed → 409.
 *   - bulkMentionConfirmed=true → 정상 전송.
 *   - 임계값 미만 → 무confirm 전송.
 *
 * 멘션 fanout 은 메시지 저장과 동일 tx 에서 UserMention outbox 행으로 기록되므로,
 * outbox 테이블을 직접 조회해 수신자 집합을 검증한다(WS drain 없이 권위 검증).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';
import { PresenceService } from '../../../src/realtime/presence/presence.service';

// 카탈로그 비트. MENTION_CHANNEL=0x2000(@channel/@here), MENTION_EVERYONE=0x0080(@everyone).
const PERMISSIONS_MENTION_CHANNEL = 0x2000;

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
let presence: PresenceService;
// 추가 멤버 — broad fanout 대상이 author 외에 존재하도록.
let memberB: Awaited<ReturnType<typeof signup>>;
let memberC: Awaited<ReturnType<typeof signup>>;
// 임계값 테스트용 더미 멤버 id(직접 prisma 삽입으로 워크스페이스 멤버수만 늘린다).
const padMemberIds: string[] = [];

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

/**
 * 워크스페이스 멤버수만 임계값 위로 채우기 위한 더미 멤버를 prisma 로 직접 삽입한다.
 * 임계값 enforce 는 게이트 통과 후·INSERT 전에 throw 하므로 이 더미들에게 실제 fanout
 * 은 발생하지 않는다(워크스페이스 멤버 count 만 소비). User/WorkspaceMember 최소 필드.
 */
async function padWorkspaceMembers(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await env.prisma.user.create({
      data: {
        id,
        email: `pad-${id}@example.test`,
        username: `pad_${id.slice(0, 8)}`,
        passwordHash: 'x',
        emailVerified: true,
      },
    });
    await env.prisma.workspaceMember.create({
      data: { workspaceId: stack.workspaceId, userId: id, role: 'MEMBER' },
    });
    padMemberIds.push(id);
  }
}

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
  presence = env.app.get(PresenceService);
  memberB = await signup(env.baseUrl, 'cmb');
  memberC = await signup(env.baseUrl, 'cmc');
  await joinWorkspace(memberB.accessToken);
  await joinWorkspace(memberC.accessToken);
  // 이 시점 워크스페이스 멤버수 = owner/admin/member/memberB/memberC = 5명(임계값 6 미만).
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.channelPermissionOverride.deleteMany({ where: { channelId: stack.channelId } });
  // 기본 알림 설정(글로벌 MENTIONS·suppressEveryone=false·비뮤트)으로 되돌려 S46 게이트가
  // broad 를 통과시켜 S94 권한/임계값 게이트만 분리 검증되게 한다.
  await env.prisma.serverNotificationPref.deleteMany({});
  await env.prisma.userChannelMute.deleteMany({});
  await env.prisma.userSettings.deleteMany({});
  // presence 초기화 — @here 테스트는 명시적으로 online 을 만든다.
  const keys = await env.redis.keys('qufox:presence:*');
  if (keys.length > 0) {
    await env.redis.del(...keys.map((k) => k.replace(/^qufox:/, '')));
  }
});

async function mentionRecipients(): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true },
  });
  return rows.map((r) => r.aggregateId).sort();
}

function postAs(token: string, body: Record<string, unknown>) {
  return request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

function patchAs(token: string, msgId: string, body: Record<string, unknown>) {
  return request(env.baseUrl)
    .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

describe('S94 @channel/@here 기본 MEMBER 허용 (MENTION_CHANNEL · FR-MSG-14)', () => {
  it('MEMBER 의 @channel 은 override 없이 통과 — 워크스페이스 멤버 전원 fanout(작성자 제외)', async () => {
    const post = await postAs(stack.member.accessToken, { content: 'heads up @channel' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.channel).toBe(true);
    const recipients = await mentionRecipients();
    const expected = [
      stack.owner.userId,
      stack.admin.userId,
      memberB.userId,
      memberC.userId,
    ].sort();
    expect(recipients).toEqual(expected);
  });

  it('MEMBER 의 @here 는 override 없이 통과(online 멤버만) — 권한 게이트 통과', async () => {
    await presence.register({
      sessionId: 'sess-here-b',
      userId: memberB.userId,
      workspaceIds: [stack.workspaceId],
      preference: 'auto',
    });
    const post = await postAs(stack.member.accessToken, { content: 'standup @here' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.here).toBe(true);
    // 권한 게이트 통과(여기서 strip 됐다면 here=false 였을 것) + online 필터 → memberB 만.
    expect(await mentionRecipients()).toEqual([memberB.userId]);
  });

  it('MEMBER 의 @everyone 은 strip(MENTION_EVERYONE base off 유지) — fanout 0', async () => {
    const post = await postAs(stack.member.accessToken, { content: 'all @everyone' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.everyone).toBe(false);
    expect(await mentionRecipients()).toEqual([]);
  });

  it('채널 ROLE override DENY(MENTION_CHANNEL) → MEMBER @channel 박탈(strip)', async () => {
    // MEMBER 시스템 역할에 MENTION_CHANNEL deny override 부여. 요청 mask 는 number
    // (PermissionMaskSchema=z.number().int() — 응답 DTO 만 BigInt-as-string·ADR-11).
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/roles`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ role: 'MEMBER', denyMask: PERMISSIONS_MENTION_CHANNEL })
      .expect(201);

    const post = await postAs(stack.member.accessToken, { content: 'blocked @channel' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.channel).toBe(false);
    expect(await mentionRecipients()).toEqual([]);
  });
});

describe('S94 서버 임계값 enforce (BULK_MENTION_CONFIRM_REQUIRED · FR-MSG-14)', () => {
  it('멤버수 5(<6) @everyone(OWNER 권한) + 무confirm → 정상 전송(임계값 미만)', async () => {
    // 현재 멤버수 5명. OWNER 는 @everyone 권한 보유 → 게이트 통과, 임계값 미만이라 confirm 불요.
    const post = await postAs(stack.owner.accessToken, { content: 'small @everyone' });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions.everyone).toBe(true);
  });

  it('멤버수 ≥6 @everyone(OWNER) + 무confirm → 409 BULK_MENTION_CONFIRM_REQUIRED (메시지 미저장)', async () => {
    await padWorkspaceMembers(1); // 5 → 6명(임계값 도달).
    const idem = randomUUID();
    const res = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set('idempotency-key', idem)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'big @everyone' });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('BULK_MENTION_CONFIRM_REQUIRED');
    expect(res.body.details).toMatchObject({ mention: 'everyone', threshold: 6 });
    // INSERT 전 throw → 채널에 메시지가 저장되지 않았다(idempotencyKey 미소비).
    const stored = await env.prisma.message.count({ where: { channelId: stack.channelId } });
    expect(stored).toBe(0);

    // 같은 idempotencyKey + bulkMentionConfirmed=true 로 재전송하면 정상 저장(키 미소비 확인).
    const retry = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set('idempotency-key', idem)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'big @everyone', bulkMentionConfirmed: true });
    expect(retry.status).toBe(201);
    expect(retry.body.message.mentions.everyone).toBe(true);
  });

  it('멤버수 ≥50 @channel(MEMBER 기본 허용) + 무confirm → 409 (threshold=50)', async () => {
    // 현재 6명 → 50명까지 채운다(누적 더미 멤버 삽입).
    const current = await env.prisma.workspaceMember.count({
      where: { workspaceId: stack.workspaceId },
    });
    if (current < 50) await padWorkspaceMembers(50 - current);

    const res = await postAs(stack.member.accessToken, { content: 'mass @channel' });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('BULK_MENTION_CONFIRM_REQUIRED');
    expect(res.body.details).toMatchObject({ mention: 'channel', threshold: 50 });
  });

  it('멤버수 ≥50 @channel + bulkMentionConfirmed=true → 정상 전송', async () => {
    const current = await env.prisma.workspaceMember.count({
      where: { workspaceId: stack.workspaceId },
    });
    if (current < 50) await padWorkspaceMembers(50 - current);

    const res = await postAs(stack.member.accessToken, {
      content: 'mass @channel',
      bulkMentionConfirmed: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.message.mentions.channel).toBe(true);
  });

  it('멤버수 ≥50 이어도 @everyone 권한 없는 MEMBER → @everyone strip → 임계값 대상 아님(정상 전송)', async () => {
    const current = await env.prisma.workspaceMember.count({
      where: { workspaceId: stack.workspaceId },
    });
    if (current < 50) await padWorkspaceMembers(50 - current);

    // MEMBER 는 @everyone 권한이 없어 게이트가 everyone=false 로 strip → broadGated.everyone=false
    // → 임계값 체크 대상 아님. @channel 도 없으므로 confirm 불요로 정상 전송.
    const res = await postAs(stack.member.accessToken, { content: 'sneaky @everyone' });
    expect(res.status).toBe(201);
    expect(res.body.message.mentions.everyone).toBe(false);
  });
});

describe('S94 fix-forward 편집 경로 임계값 enforce (HIGH-1 — send 우회 방지 · FR-MSG-14)', () => {
  it('평문 send 후 ≥50 워크스페이스에서 PATCH 로 @channel 신규 추가 + 무confirm → 409 (편집 미적용)', async () => {
    const current = await env.prisma.workspaceMember.count({
      where: { workspaceId: stack.workspaceId },
    });
    if (current < 50) await padWorkspaceMembers(50 - current);

    // 1) 평문(broad 멘션 없음) 메시지 send — 임계값과 무관하게 정상 저장.
    const sent = await postAs(stack.member.accessToken, { content: 'plain heads-up' });
    expect(sent.status).toBe(201);
    expect(sent.body.message.mentions.channel).toBe(false);
    const msgId = sent.body.message.id as string;
    const version = sent.body.message.version as number;
    // 평문 send 는 broad fanout 0 — 멘션 수신자 없음.
    expect(await mentionRecipients()).toEqual([]);

    // 2) 편집으로 @channel 주입(신규 추가) + 무confirm → 서버 안전망이 409 로 거부.
    const edit = await patchAs(stack.member.accessToken, msgId, {
      content: 'now with @channel injected',
      expectedVersion: version,
    });
    expect(edit.status).toBe(409);
    expect(edit.body.errorCode).toBe('BULK_MENTION_CONFIRM_REQUIRED');
    expect(edit.body.details).toMatchObject({ mention: 'channel', threshold: 50 });

    // 편집이 미적용 — 본문/멘션이 그대로다(UPDATE 미실행 · version 불변).
    const after = await env.prisma.message.findFirst({ where: { id: msgId } });
    expect(after?.content).toBe('plain heads-up');
    expect((after?.mentions as { channel?: boolean } | null)?.channel ?? false).toBe(false);
    expect(after?.version).toBe(version);
    // broad fanout 도 발생하지 않았다(편집 거부 → resolveBroadMentionRecipients 미도달).
    expect(await mentionRecipients()).toEqual([]);
  });

  it('편집으로 @channel 신규 추가 + bulkMentionConfirmed=true → 적용(편집 반영)', async () => {
    const current = await env.prisma.workspaceMember.count({
      where: { workspaceId: stack.workspaceId },
    });
    if (current < 50) await padWorkspaceMembers(50 - current);

    const sent = await postAs(stack.member.accessToken, { content: 'plain body 2' });
    expect(sent.status).toBe(201);
    const msgId = sent.body.message.id as string;
    const version = sent.body.message.version as number;

    const edit = await patchAs(stack.member.accessToken, msgId, {
      content: 'confirmed @channel edit',
      expectedVersion: version,
      bulkMentionConfirmed: true,
    });
    expect(edit.status).toBe(200);
    expect(edit.body.message.mentions.channel).toBe(true);

    // 편집이 반영됐고, 신규 추가된 broad 멘션이 실제 멤버 전원(작성자 제외)에게 fanout 됐다.
    const after = await env.prisma.message.findFirst({ where: { id: msgId } });
    expect(after?.content).toBe('confirmed @channel edit');
    const recipients = await mentionRecipients();
    // 작성자(member) 제외 — owner/admin/memberB/memberC + 더미 pad 멤버 전원.
    expect(recipients).toContain(stack.owner.userId);
    expect(recipients).toContain(memberB.userId);
    expect(recipients).not.toContain(stack.member.userId);
  });

  it('이미 @channel 이 있던 메시지의 내용만 편집(신규추가 아님) → 재confirm 불요(200)', async () => {
    const current = await env.prisma.workspaceMember.count({
      where: { workspaceId: stack.workspaceId },
    });
    if (current < 50) await padWorkspaceMembers(50 - current);

    // 최초 전송 시점에 confirm 으로 @channel 을 박은 메시지(임계값 통과).
    const sent = await postAs(stack.member.accessToken, {
      content: 'initial @channel body',
      bulkMentionConfirmed: true,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.mentions.channel).toBe(true);
    const msgId = sent.body.message.id as string;
    const version = sent.body.message.version as number;

    // 내용만 바꾸는 편집(여전히 @channel 유지) — 신규 추가가 아니므로 재confirm 없이 통과.
    const edit = await patchAs(stack.member.accessToken, msgId, {
      content: 'edited but still @channel',
      expectedVersion: version,
    });
    expect(edit.status).toBe(200);
    expect(edit.body.message.mentions.channel).toBe(true);
    const after = await env.prisma.message.findFirst({ where: { id: msgId } });
    expect(after?.content).toBe('edited but still @channel');
  });
});
