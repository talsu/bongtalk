/**
 * S46 (D06 / FR-MN-05/06/07/08) 통합 검증 — 실 Postgres + Redis(testcontainer).
 *
 * 커버리지(S05 교훈 — 마이그레이션 실DB 적용 + 3계층 fold + fanout 게이트 + 일괄 + cron):
 *   - 마이그레이션 적용(NotifLevel enum + UserSettings + ServerNotificationPref +
 *     UserChannelMute.level) — 본 스펙이 도는 것 자체가 prisma migrate deploy 검증.
 *   - 글로벌/서버/채널 알림 설정 GET/PUT/PATCH/DELETE API.
 *   - NotifLevel 3계층 resolve(채널 > 서버 > 글로벌 상속)를 실 멘션 fanout 으로 검증:
 *       · NOTHING → mention.received outbox 스킵(직접·broad 모두).
 *       · MENTIONS → broad(@everyone) 스킵·직접 @username 통과.
 *       · ALL → 통과.
 *       · isMuted(서버/채널) → 스킵.
 *   - 카테고리 일괄 적용 → 하위 채널 전체 level/mute upsert.
 *   - 뮤트 만료 cron sweep(server 해제 + channel level=null 삭제 / level 보존 unmute).
 *
 * 멘션 fanout 은 메시지 저장과 동일 tx 에서 UserMention outbox 행으로 기록되므로,
 * outbox 를 직접 조회해 수신자 집합을 권위 검증한다(WS drain 없이).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, signup, setupMsgIntEnv } from './helpers';
import { MuteExpiryCron } from '../../../src/notifications/mute-expiry.cron';

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
  memberB = await signup(env.baseUrl, 'nlb');
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

/** UserMention outbox 수신자 집합(정렬). */
async function mentionRecipients(): Promise<string[]> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { aggregateType: 'UserMention', eventType: 'mention.received' },
    select: { aggregateId: true },
  });
  return rows.map((r) => r.aggregateId).sort();
}

/** owner 가 채널에 메시지를 보낸다(직접/broad 멘션 포함 가능). */
async function ownerSends(content: string): Promise<void> {
  // owner 는 OWNER 라 MENTION_EVERYONE 권한 보유 → @everyone 게이트 통과.
  const post = await request(env.baseUrl)
    .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(stack.owner.accessToken))
    .send({ content });
  expect(post.status).toBe(201);
}

describe('S46 글로벌 알림 설정 API (/me/settings/notifications, FR-MN-05)', () => {
  it('행 없으면 기본 MENTIONS, PATCH 로 upsert', async () => {
    const tok = bearer(stack.member.accessToken);
    const g0 = await request(env.baseUrl)
      .get('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok);
    expect(g0.status).toBe(200);
    expect(g0.body).toEqual({
      notifTrigger: 'MENTIONS',
      keywords: [],
      dndUntil: null,
      dndSchedule: null,
    });

    const p = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ notifTrigger: 'ALL', keywords: ['deploy', 'incident'] });
    expect(p.status).toBe(200);
    expect(p.body.notifTrigger).toBe('ALL');
    expect(p.body.keywords).toEqual(['deploy', 'incident']);

    // 부분 업데이트 — notifTrigger 만 바꿔도 keywords 유지.
    const p2 = await request(env.baseUrl)
      .patch('/me/settings/notifications')
      .set('origin', ORIGIN)
      .set(tok)
      .send({ notifTrigger: 'NOTHING' });
    expect(p2.body.notifTrigger).toBe('NOTHING');
    expect(p2.body.keywords).toEqual(['deploy', 'incident']);
  });
});

describe('S46 서버 알림 설정 API (/workspaces/:id/notification-preferences, FR-MN-06)', () => {
  it('GET 기본 → PUT level/뮤트 → DELETE 뮤트 해제', async () => {
    const ws = stack.workspaceId;
    const tok = bearer(stack.member.accessToken);
    const g0 = await request(env.baseUrl)
      .get(`/workspaces/${ws}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok);
    expect(g0.status).toBe(200);
    expect(g0.body.level).toBe('MENTIONS');
    expect(g0.body.isMuted).toBe(false);

    const put = await request(env.baseUrl)
      .put(`/workspaces/${ws}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok)
      .send({ level: 'NOTHING', isMuted: true, muteDuration: '1h' });
    expect(put.status).toBe(200);
    expect(put.body.level).toBe('NOTHING');
    expect(put.body.isMuted).toBe(true);
    expect(put.body.muteUntil).toBe('2025-01-01T01:00:00.000Z');

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${ws}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok);
    expect(del.status).toBe(200);
    expect(del.body.isMuted).toBe(false);
    expect(del.body.muteUntil).toBeNull();
    // level 오버라이드는 보존(뮤트 해제만).
    expect(del.body.level).toBe('NOTHING');
  });

  it('비멤버는 404', async () => {
    const outsider = await signup(env.baseUrl, 'nlout');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${stack.workspaceId}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(bearer(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('S46 채널 알림 설정 API (FR-MN-07)', () => {
  it('GET 기본(level null) → PUT level → DELETE 해제', async () => {
    const ws = stack.workspaceId;
    const ch = stack.channelId;
    const tok = bearer(stack.member.accessToken);
    const g0 = await request(env.baseUrl)
      .get(`/workspaces/${ws}/channels/${ch}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok);
    expect(g0.status).toBe(200);
    expect(g0.body).toEqual({ level: null, isMuted: false, muteUntil: null });

    const put = await request(env.baseUrl)
      .put(`/workspaces/${ws}/channels/${ch}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok)
      .send({ level: 'ALL' });
    expect(put.status).toBe(200);
    expect(put.body.level).toBe('ALL');

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${ws}/channels/${ch}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ level: null, isMuted: false, muteUntil: null });
  });
});

describe('S46 NotifLevel 3계층 fanout 게이트 (FR-MN-05/06/07)', () => {
  // member 를 @username 직접 멘션 + @everyone broad 동시에 보낸다.
  // owner 가 보내므로 작성자(owner)는 제외, member/admin/memberB 가 후보.
  const directThenBroad = () => `direct @${stack.member.username} and @everyone`;

  it('글로벌 NOTHING → 직접·broad 모두 스킵', async () => {
    await env.prisma.userSettings.create({
      data: { userId: stack.member.userId, notifTrigger: 'NOTHING' },
    });
    await ownerSends(directThenBroad());
    // member 는 NOTHING 이라 직접 @username 도 스킵. admin/memberB 는 글로벌 기본
    // MENTIONS 라 broad(@everyone) 스킵 → 아무도 안 받음.
    expect(await mentionRecipients()).toEqual([]);
  });

  it('글로벌 MENTIONS(기본) → 직접만 통과·broad 스킵', async () => {
    await ownerSends(directThenBroad());
    // member 는 직접 @username → 통과. admin/memberB 는 broad 뿐이라 스킵.
    expect(await mentionRecipients()).toEqual([stack.member.userId]);
  });

  it('글로벌 ALL → broad 도 통과', async () => {
    for (const uid of [stack.member.userId, stack.admin.userId, memberB.userId]) {
      await env.prisma.userSettings.create({ data: { userId: uid, notifTrigger: 'ALL' } });
    }
    await ownerSends(directThenBroad());
    expect(await mentionRecipients()).toEqual(
      [stack.member.userId, stack.admin.userId, memberB.userId].sort(),
    );
  });

  it('서버 ALL 이 글로벌 MENTIONS 를 오버라이드 → broad 통과', async () => {
    // member 는 글로벌 MENTIONS(기본) 이지만 서버에서 ALL 로 올림.
    await env.prisma.serverNotificationPref.create({
      data: { userId: stack.member.userId, workspaceId: stack.workspaceId, level: 'ALL' },
    });
    // admin/memberB 는 broad 만 받게 @everyone 으로만 보낸다(직접 멘션 없음).
    await ownerSends('hello @everyone');
    // member 만 서버 ALL → broad 통과. admin/memberB 는 글로벌 MENTIONS → 스킵.
    expect(await mentionRecipients()).toEqual([stack.member.userId]);
  });

  it('채널 NOTHING 이 서버 ALL 을 오버라이드 → 직접도 스킵', async () => {
    await env.prisma.serverNotificationPref.create({
      data: { userId: stack.member.userId, workspaceId: stack.workspaceId, level: 'ALL' },
    });
    // 채널에서 NOTHING 으로 내림(가장 좁은 범위 우선).
    await env.prisma.userChannelMute.create({
      data: { userId: stack.member.userId, channelId: stack.channelId, level: 'NOTHING' },
    });
    await ownerSends(`direct @${stack.member.username}`);
    expect(await mentionRecipients()).toEqual([]);
  });

  it('서버 isMuted → level=ALL 이라도 직접 멘션 스킵', async () => {
    await env.prisma.serverNotificationPref.create({
      data: {
        userId: stack.member.userId,
        workspaceId: stack.workspaceId,
        level: 'ALL',
        isMuted: true,
        muteUntil: null,
      },
    });
    await ownerSends(`direct @${stack.member.username}`);
    expect(await mentionRecipients()).toEqual([]);
  });

  it('채널 뮤트(UserChannelMute mutedUntil null) → 직접 멘션 스킵', async () => {
    await env.prisma.userChannelMute.create({
      data: { userId: stack.member.userId, channelId: stack.channelId, mutedUntil: null },
    });
    await ownerSends(`direct @${stack.member.username}`);
    expect(await mentionRecipients()).toEqual([]);
  });
});

describe('S46 카테고리 일괄 적용 (FR-MN-07)', () => {
  it('카테고리 하위 채널 전체에 level/mute bulk upsert', async () => {
    const ws = stack.workspaceId;
    const tok = bearer(stack.member.accessToken);
    // 카테고리 + 하위 채널 2개 생성(admin 권한).
    const cat = await request(env.baseUrl)
      .post(`/workspaces/${ws}/categories`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ name: `cat-${Date.now().toString(36)}` });
    expect(cat.status).toBe(201);
    const categoryId = cat.body.id as string;

    const chIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await request(env.baseUrl)
        .post(`/workspaces/${ws}/channels`)
        .set('origin', ORIGIN)
        .set(bearer(stack.admin.accessToken))
        .send({ name: `catch-${i}-${Date.now().toString(36)}`, type: 'TEXT', categoryId });
      expect(c.status).toBe(201);
      chIds.push(c.body.id as string);
    }

    // 하위 채널 중 하나를 path 로 쓰되 categoryId 를 넘겨 일괄 적용.
    const put = await request(env.baseUrl)
      .put(`/workspaces/${ws}/channels/${chIds[0]}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(tok)
      .send({ level: 'NOTHING', categoryId });
    expect(put.status).toBe(200);
    expect((put.body.channelIds as string[]).sort()).toEqual([...chIds].sort());

    // 두 채널 모두 NOTHING 오버라이드가 박혔는지 DB 권위 검증.
    const rows = await env.prisma.userChannelMute.findMany({
      where: { userId: stack.member.userId, channelId: { in: chIds } },
      select: { channelId: true, level: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.level === 'NOTHING')).toBe(true);
  });
});

describe('S46 뮤트 만료 cron sweep (FR-MN-08)', () => {
  it('만료 server unmute + channel(level null 삭제 / level 보존 unmute)', async () => {
    const cron = env.app.get(MuteExpiryCron);
    const past = new Date('2024-12-31T23:00:00Z'); // now(2025-01-01) 이전 = 만료.
    const future = new Date('2025-01-01T02:00:00Z'); // 미래 = 유지.

    // 1) server: 만료 뮤트.
    await env.prisma.serverNotificationPref.create({
      data: {
        userId: stack.member.userId,
        workspaceId: stack.workspaceId,
        level: 'ALL',
        isMuted: true,
        muteUntil: past,
      },
    });
    // 2) channel level=null + 만료 뮤트 → 삭제.
    await env.prisma.userChannelMute.create({
      data: { userId: stack.member.userId, channelId: stack.channelId, mutedUntil: past },
    });
    // 3) channel level=NOTHING + 만료 뮤트 → mutedUntil=null 로 unmute(level 보존).
    const ch2 = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(stack.admin.accessToken))
      .send({ name: `cron-${Date.now().toString(36)}`, type: 'TEXT' });
    const ch2Id = ch2.body.id as string;
    await env.prisma.userChannelMute.create({
      data: { userId: stack.member.userId, channelId: ch2Id, level: 'NOTHING', mutedUntil: past },
    });
    // 4) 미래 뮤트는 sweep 대상 아님(유지 확인용).
    await env.prisma.userChannelMute.create({
      data: { userId: memberB.userId, channelId: stack.channelId, mutedUntil: future },
    });

    const res = await cron.sweep(new Date('2025-01-01T00:00:00Z'));
    expect(res.server).toBe(1);
    expect(res.channelCleared).toBe(1);
    expect(res.channelUnmuted).toBe(1);

    // server 해제됨.
    const sv = await env.prisma.serverNotificationPref.findUnique({
      where: {
        userId_workspaceId: { userId: stack.member.userId, workspaceId: stack.workspaceId },
      },
    });
    expect(sv?.isMuted).toBe(false);
    expect(sv?.muteUntil).toBeNull();
    expect(sv?.level).toBe('ALL'); // level 보존.

    // channel level=null 행 삭제됨.
    const cleared = await env.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId: stack.member.userId, channelId: stack.channelId } },
    });
    expect(cleared).toBeNull();

    // channel level=NOTHING 행은 unmute(mutedUntil null) + level 보존.
    const kept = await env.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId: stack.member.userId, channelId: ch2Id } },
    });
    expect(kept?.mutedUntil).toBeNull();
    expect(kept?.level).toBe('NOTHING');

    // 미래 뮤트는 그대로.
    const futureRow = await env.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId: memberB.userId, channelId: stack.channelId } },
    });
    expect(futureRow?.mutedUntil?.toISOString()).toBe(future.toISOString());
  });
});
