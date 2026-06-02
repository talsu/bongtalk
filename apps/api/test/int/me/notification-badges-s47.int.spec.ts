import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  bearer,
  type ChIntEnv,
  ORIGIN,
  seedWorkspaceWithRoles,
  setupChIntEnv,
} from '../channels/helpers';

/**
 * S47 (D06 / FR-MN-14 / FR-MN-20): `GET /me/notification-badges` 집계 검증(실 DB).
 *
 * 핵심 회귀:
 *   - 서버 단위 mentionCount/unreadCount 가 채널들의 합으로 정확히 집계된다.
 *   - **isMuted 채널은 카운트에서 제외**된다(FR-MN-14 — 배지 완전 숨김).
 *   - **isMuted 서버(워크스페이스)는 전체가 0** 으로 집계된다.
 *   - 가입한 워크스페이스는 카운트 0 이어도 한 줄 반환된다.
 */
let env: ChIntEnv;

beforeAll(async () => {
  env = await setupChIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(
  workspaceId: string,
  ownerToken: string,
  name: string,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(ownerToken))
    .send({ name, type: 'TEXT' });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function mention(
  workspaceId: string,
  channelId: string,
  token: string,
  targetUsername: string,
): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content: `heads up @${targetUsername}` });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
}

interface BadgesResponse {
  workspaces: Array<{ workspaceId: string; mentionCount: number; unreadCount: number }>;
}

async function fetchBadges(token: string): Promise<BadgesResponse> {
  const res = await request(env.baseUrl)
    .get('/me/notification-badges')
    .set('origin', ORIGIN)
    .set(bearer(token));
  if (res.status !== 200) throw new Error(`badges fetch failed: ${res.status} ${res.text}`);
  return res.body as BadgesResponse;
}

describe('GET /me/notification-badges (S47 · FR-MN-14/20)', () => {
  it('비뮤트 채널들의 멘션/미읽을 서버 단위로 합산하고, isMuted 채널은 제외한다', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chA = await createChannel(workspaceId, owner.accessToken, 'badge-a');
    const chB = await createChannel(workspaceId, owner.accessToken, 'badge-b');

    // chA: member 를 2회 멘션. chB: 1회 멘션.
    await mention(workspaceId, chA, owner.accessToken, member.username);
    await mention(workspaceId, chA, owner.accessToken, member.username);
    await mention(workspaceId, chB, owner.accessToken, member.username);

    // 뮤트 전: chA(2) + chB(1) = 멘션 3. 미읽도 같음(멘션 메시지 = 미읽 메시지).
    const before = await fetchBadges(member.accessToken);
    const wsBefore = before.workspaces.find((w) => w.workspaceId === workspaceId);
    expect(wsBefore).toBeDefined();
    expect(wsBefore!.mentionCount).toBe(3);
    expect(wsBefore!.unreadCount).toBe(3);

    // chB 를 활성 뮤트(영구). UserChannelMute 행 직접 삽입(서버 진실값 게이트 검증).
    await env.prisma.userChannelMute.create({
      data: { userId: member.userId, channelId: chB, isMuted: true, mutedUntil: null },
    });

    // 뮤트 후: chB 제외 → chA(2)만. 멘션 2 · 미읽 2.
    const after = await fetchBadges(member.accessToken);
    const wsAfter = after.workspaces.find((w) => w.workspaceId === workspaceId);
    expect(wsAfter).toBeDefined();
    expect(wsAfter!.mentionCount).toBe(2);
    expect(wsAfter!.unreadCount).toBe(2);
  });

  it('isMuted 서버(워크스페이스)는 전체 카운트가 0 이다', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel(workspaceId, owner.accessToken, 'svc-mute');
    await mention(workspaceId, ch, owner.accessToken, member.username);

    const before = await fetchBadges(member.accessToken);
    expect(before.workspaces.find((w) => w.workspaceId === workspaceId)!.mentionCount).toBe(1);

    // 서버(워크스페이스) 전체 뮤트(영구).
    await env.prisma.serverNotificationPref.create({
      data: { userId: member.userId, workspaceId, isMuted: true, muteUntil: null },
    });

    const after = await fetchBadges(member.accessToken);
    const ws = after.workspaces.find((w) => w.workspaceId === workspaceId);
    // 가입 워크스페이스라 한 줄은 유지되되, 카운트는 0.
    expect(ws).toBeDefined();
    expect(ws!.mentionCount).toBe(0);
    expect(ws!.unreadCount).toBe(0);
  });

  it('만료된 채널 뮤트는 제외하지 않는다(과거 mutedUntil → 비활성)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel(workspaceId, owner.accessToken, 'expired-mute');
    await mention(workspaceId, ch, owner.accessToken, member.username);

    // 과거 시각으로 만료된 뮤트 — 활성 뮤트가 아니므로 카운트에 산입돼야 한다.
    await env.prisma.userChannelMute.create({
      data: {
        userId: member.userId,
        channelId: ch,
        isMuted: true,
        mutedUntil: new Date('2024-12-31T00:00:00Z'),
      },
    });

    const badges = await fetchBadges(member.accessToken);
    const ws = badges.workspaces.find((w) => w.workspaceId === workspaceId);
    expect(ws!.mentionCount).toBe(1);
  });
});
