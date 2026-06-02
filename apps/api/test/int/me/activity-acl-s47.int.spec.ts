import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  bearer,
  type ChIntEnv,
  ORIGIN,
  seedWorkspaceWithRoles,
  setupChIntEnv,
} from '../channels/helpers';
import { MeActivityService } from '../../../src/me/me-activity.service';
import { MeNotificationBadgesService } from '../../../src/me/me-notification-badges.service';

/**
 * S47 fix-forward (실 DB · 게이트): Activity Inbox 가 노출한 선존 ACL 버그들을
 * 회귀 방어한다.
 *
 *  - BLOCKER-3: me-activity 의 `OR TRUE` private ACL 가드 사문화 → 제거. 비가시
 *    private 채널의 멘션이 활동 피드/카운트에 누수되지 않는다.
 *  - BLOCKER-4: badges 의 비공개 가시성이 rail/ACK 와 동일한 canonical 5-step fold
 *    (user DENY > role ALLOW). role-ALLOW + user-DENY READ private 채널은 배지 제외.
 *  - BLOCKER-5: badgeFor(단일 ws) 가 전 워크스페이스 집계 없이 그 ws 만 집계하되
 *    badges()(전체 집계)의 해당 행과 동일한 값을 낸다.
 *  - BLOCKER-6: markRead IDOR — 타인 activity 를 강제 읽음 표시 불가(403).
 */
let env: ChIntEnv;
let activity: MeActivityService;
let badges: MeNotificationBadgesService;

beforeAll(async () => {
  env = await setupChIntEnv();
  activity = env.app.get(MeActivityService);
  badges = env.app.get(MeNotificationBadgesService);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const READ = 0x0001;

async function createChannel(
  workspaceId: string,
  token: string,
  name: string,
  isPrivate = false,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ name, type: 'TEXT', isPrivate });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function post(
  workspaceId: string,
  channelId: string,
  token: string,
  content: string,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`post failed: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

describe('Activity/badges ACL (S47 fix-forward · 실 DB)', () => {
  it('BLOCKER-3: 비가시 private 채널의 멘션은 활동 피드/카운트에서 제외된다(OR TRUE 제거)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);

    const privCh = await createChannel(workspaceId, owner.accessToken, 'secret-feed', true);
    // owner 가 private 채널에서 member 를 멘션한다. member 는 그 채널 가시성이 없음
    // (USER/ROLE READ override 없음). OR TRUE 제거 전엔 acc 가 모든 채널을 통과시켜
    // mentions CTE 의 overrideBit 재필터에만 의존했는데, 본 케이스는 양쪽 모두에서
    // 빠져야 한다 — 비가시 private 채널 멘션은 노출 금지.
    await post(workspaceId, privCh, owner.accessToken, `heads up @${member.username}`);

    const page = await activity.page(member.userId, 'all', null, 50);
    expect(page.items.some((i) => i.channelId === privCh)).toBe(false);

    const counts = await activity.unreadCounts(member.userId);
    expect(counts.mentions).toBe(0);
    expect(counts.total).toBe(0);
  });

  it('BLOCKER-3: 가시(USER READ allow) private 채널의 멘션은 정상 노출된다', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const privCh = await createChannel(workspaceId, owner.accessToken, 'shared-feed', true);
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh,
        principalType: 'USER',
        principalId: member.userId,
        allowMask: READ,
        denyMask: 0,
      },
    });
    await post(workspaceId, privCh, owner.accessToken, `welcome @${member.username}`);

    const page = await activity.page(member.userId, 'mentions', null, 50);
    expect(page.items.some((i) => i.channelId === privCh)).toBe(true);
    const counts = await activity.unreadCounts(member.userId);
    expect(counts.mentions).toBe(1);
  });

  it('BLOCKER-4: badges 는 role-ALLOW + user-DENY READ private 채널을 제외한다(5-step fold)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const privCh = await createChannel(workspaceId, owner.accessToken, 'fold-badge', true);
    // ROLE(MEMBER) ALLOW READ + USER(member) DENY READ → 5단계 fold 로 비가시.
    // 종전 2-step union 도 (allow & ~deny)=0 으로 비가시지만, 본 케이스는 헬퍼
    // 공유 후에도 동일 결과임을 보장한다(rail/ACK 와 단일 truth-source).
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh,
        principalType: 'ROLE',
        principalId: 'MEMBER',
        allowMask: READ,
        denyMask: 0,
      },
    });
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh,
        principalType: 'USER',
        principalId: member.userId,
        allowMask: 0,
        denyMask: READ,
      },
    });
    // owner 가 멘션 — member 비가시라 배지 0 이어야 한다.
    await post(workspaceId, privCh, owner.accessToken, `secret @${member.username}`);

    const rows = await badges.badges(member.userId);
    const ws = rows.find((r) => r.workspaceId === workspaceId);
    expect(ws).toBeDefined();
    expect(ws?.mentionCount).toBe(0);
    expect(ws?.unreadCount).toBe(0);
  });

  it('BLOCKER-4: userAllow(READ) beats roleDeny(READ) → badges 에 포함(rail 과 정합)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const privCh = await createChannel(workspaceId, owner.accessToken, 'fold-visible', true);
    // ROLE DENY READ + USER ALLOW READ → 5단계 fold 로 가시(종전 2-step union 은
    // 가렸음 — 헬퍼 공유로 badges 도 rail 과 동일하게 가시 처리).
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh,
        principalType: 'ROLE',
        principalId: 'MEMBER',
        allowMask: 0,
        denyMask: READ,
      },
    });
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: privCh,
        principalType: 'USER',
        principalId: member.userId,
        allowMask: READ,
        denyMask: 0,
      },
    });
    await post(workspaceId, privCh, owner.accessToken, `psst @${member.username}`);

    const rows = await badges.badges(member.userId);
    const ws = rows.find((r) => r.workspaceId === workspaceId);
    expect(ws?.mentionCount).toBe(1);
    expect(ws?.unreadCount).toBe(1);
  });

  it('BLOCKER-5: badgeFor(단일 ws) 는 badges()(전체)의 해당 행과 동일한 값을 낸다', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const pubCh = await createChannel(workspaceId, owner.accessToken, 'pub-badge');
    await post(workspaceId, pubCh, owner.accessToken, `hi @${member.username}`);
    await post(workspaceId, pubCh, owner.accessToken, 'just chatter');

    const all = await badges.badges(member.userId);
    const fromAll = all.find((r) => r.workspaceId === workspaceId);
    const single = await badges.badgeFor(member.userId, workspaceId);
    expect(single.workspaceId).toBe(workspaceId);
    expect(single.mentionCount).toBe(fromAll?.mentionCount);
    expect(single.unreadCount).toBe(fromAll?.unreadCount);
    expect(single.mentionCount).toBe(1);
    expect(single.unreadCount).toBe(2);
  });

  it('BLOCKER-6: markRead IDOR — 타인 수신 activity 를 강제 읽음 표시할 수 없다(403)', async () => {
    const { workspaceId, owner, member, nonMember } = await seedWorkspaceWithRoles(env.baseUrl);
    const pubCh = await createChannel(workspaceId, owner.accessToken, 'idor-ch');
    // owner 가 member 를 멘션 — 이 mention activity 의 수신자는 member 다.
    const msgId = await post(workspaceId, pubCh, owner.accessToken, `tag @${member.username}`);
    const activityKey = `mention:${msgId}`;

    // member 본인은 읽음 처리 성공(소유자).
    const okRes = await request(env.baseUrl)
      .post(`/me/activity/${encodeURIComponent(activityKey)}/read`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(okRes.status).toBe(204);

    // 워크스페이스 외부 nonMember 가 같은 activityKey 를 읽음 처리 시도 → 403.
    const idorRes = await request(env.baseUrl)
      .post(`/me/activity/${encodeURIComponent(activityKey)}/read`)
      .set('origin', ORIGIN)
      .set(bearer(nonMember.accessToken));
    expect(idorRes.status).toBe(403);

    // owner(작성자=자기 자신) 도 자기 멘션이 아니므로(수신자=member) 403.
    const ownerRes = await request(env.baseUrl)
      .post(`/me/activity/${encodeURIComponent(activityKey)}/read`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(ownerRes.status).toBe(403);
  });

  it('BLOCKER-6: cursor Invalid Date → 400', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .get('/me/activity')
      .query({ filter: 'all', cursor: 'not-a-date|mention:abc', limit: 25 })
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(res.status).toBe(400);
  });
});
