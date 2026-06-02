/**
 * S48 (D06 / FR-MN-10/11/12) 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * 커버리지:
 *   - FR-MN-11: dndUntil 임시 snooze → 멘션 fanout(mention.received outbox) 억제.
 *     · dndUntil 미래 → 억제. dndUntil 과거(query-time 만료) → 정상 통과.
 *     · PATCH /me/settings/notifications 로 과거 dndUntil 전송 시 400(VALIDATION_FAILED).
 *   - FR-MN-10: PATCH keywords 25개 통과 / 26개 400(KEYWORD_LIMIT_EXCEEDED) + trim/dedupe.
 *
 * 멘션 fanout 은 메시지 저장과 동일 tx 에서 UserMention outbox 행으로 기록되므로,
 * outbox 를 직접 조회해 수신자 집합을 권위 검증한다(WS drain 없이).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';

let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;
let memberB: Awaited<ReturnType<typeof signup>>;

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
  memberB = await signup(env.baseUrl, 's48b');
  await joinWorkspace(memberB.accessToken);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
  await env.prisma.userChannelMute.deleteMany({});
  await env.prisma.serverNotificationPref.deleteMany({});
  await env.prisma.userSettings.deleteMany({});
});

async function mentionRecipients(): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true },
  });
  return rows.map((r) => r.aggregateId).sort();
}

async function ownerSends(content: string): Promise<void> {
  const post = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ content });
  expect(post.status).toBe(201);
}

describe('S48 dndUntil snooze 멘션 fanout 억제 (FR-MN-11)', () => {
  it('dndUntil 미래(send-time 활성) → 멘션 outbox 스킵', async () => {
    // member 만 send-time(2025-01-01T00:00:00Z) 이후 1시간까지 snooze.
    await env.prisma.userSettings.create({
      data: {
        userId: stack.member.userId,
        notifTrigger: 'MENTIONS',
        dndUntil: new Date('2025-01-01T01:00:00.000Z'),
      },
    });
    await ownerSends(`direct @${stack.member.username} and @everyone`);
    // member: snooze 활성 → 직접·broad 모두 스킵. admin/memberB: 기본 MENTIONS → broad 알림.
    expect(await mentionRecipients()).toEqual([stack.admin.userId, memberB.userId].sort());
  });

  it('dndUntil 과거(query-time 만료) → 멘션 정상 통과', async () => {
    // dndUntil 이 send-time 이전이면 만료 — 게이트는 차단하지 않는다.
    await env.prisma.userSettings.create({
      data: {
        userId: stack.member.userId,
        notifTrigger: 'MENTIONS',
        dndUntil: new Date('2024-12-31T23:00:00.000Z'),
      },
    });
    await ownerSends(`direct @${stack.member.username}`);
    expect(await mentionRecipients()).toEqual([stack.member.userId]);
  });
});

describe('S48 글로벌 설정 API — snooze/keywords 검증 (FR-MN-10/11)', () => {
  it('PATCH dndUntil 과거 → 400', async () => {
    const tok = bearer(stack.member.accessToken);
    const res = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ dndUntil: '2024-12-31T23:59:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('PATCH dndUntil 미래 → 저장 + 응답 ISO', async () => {
    const tok = bearer(stack.member.accessToken);
    const res = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ dndUntil: '2025-01-01T02:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.dndUntil).toBe('2025-01-01T02:00:00.000Z');
  });

  it('PATCH dndUntil null → 해제', async () => {
    const tok = bearer(stack.member.accessToken);
    await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ dndUntil: '2025-01-01T02:00:00.000Z' });
    const res = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ dndUntil: null });
    expect(res.status).toBe(200);
    expect(res.body.dndUntil).toBeNull();
  });

  it('keywords 25개 → 200, 26개 → 400(KEYWORD_LIMIT_EXCEEDED)', async () => {
    const tok = bearer(stack.member.accessToken);
    const ok = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ keywords: Array.from({ length: 25 }, (_, i) => `kw${i}`) });
    expect(ok.status).toBe(200);
    expect(ok.body.keywords).toHaveLength(25);

    const over = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ keywords: Array.from({ length: 26 }, (_, i) => `kw${i}`) });
    expect(over.status).toBe(400);
    expect(over.body.errorCode).toBe('KEYWORD_LIMIT_EXCEEDED');
  });

  it('keywords trim + 대소문자 무관 dedupe 후 저장', async () => {
    const tok = bearer(stack.member.accessToken);
    const res = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ keywords: ['  deploy ', 'Deploy', 'incident'] });
    expect(res.status).toBe(200);
    expect(res.body.keywords).toEqual(['deploy', 'incident']);
  });
});
