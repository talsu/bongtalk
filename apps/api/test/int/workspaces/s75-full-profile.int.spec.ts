import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { MemberFullProfileView } from '@qufox/shared-types';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

/**
 * S75 (D14 / FR-PS-07·08 · Fork A-1, FR-PS-14 · C1) int spec.
 *
 * 커버:
 *   - GET /workspaces/:wsId/members/:userId/full-profile
 *       · 비멤버 userId → 404(enumeration 차단)
 *       · effective* 우선순위(ws override > 전역)
 *       · presignGet 파생 URL(avatar/ws-avatar)
 *       · 커스텀 역할(시스템 역할 제외) 노출
 *       · 만료 커스텀 상태 마스킹
 *   - 워크스페이스 채널 메시지 리스트 차단 마스킹(C1):
 *       내가 차단한 작성자의 메시지 본문이 placeholder 로 가려진다.
 *
 * int helper signup 은 기본 markVerified=true(S66 게이트 무회귀).
 */
let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';
const BLOCKED_PLACEHOLDER = '[차단된 사용자의 메시지]';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.redis.flushdb();
});

type Actor = Awaited<ReturnType<typeof signupAsUser>>;

let slugCounter = 0;
function uniqueSlug(): string {
  slugCounter += 1;
  return `s75-${slugCounter}-${Date.now().toString(36)}`.slice(0, 30);
}

async function createWorkspace(owner: Actor): Promise<string> {
  const res = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'S75Ws', slug: uniqueSlug() })
    .expect(201);
  return res.body.id as string;
}

async function inviteAndJoin(workspaceId: string, owner: Actor, joiner: Actor): Promise<void> {
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ maxUses: 100 })
    .expect(201);
  await request(env.baseUrl)
    .post(`/invites/${inv.body.invite.code}/accept`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${joiner.accessToken}`)
    .expect(201);
}

async function createChannel(workspaceId: string, owner: Actor): Promise<string> {
  const ch = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: `c-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
    .expect(201);
  return ch.body.id as string;
}

async function sendMessage(
  workspaceId: string,
  channelId: string,
  actor: Actor,
  content: string,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send({ content })
    .expect(201);
  return res.body.message.id as string;
}

async function getFullProfile(
  workspaceId: string,
  viewer: Actor,
  targetUserId: string,
): Promise<{ status: number; body: MemberFullProfileView }> {
  const res = await request(env.baseUrl)
    .get(`/workspaces/${workspaceId}/members/${targetUserId}/full-profile`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${viewer.accessToken}`);
  return { status: res.status, body: res.body as MemberFullProfileView };
}

describe('S75 GET /workspaces/:wsId/members/:userId/full-profile (FR-PS-07/08)', () => {
  it('404s on a userId that is not a member of the workspace (enumeration block)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const stranger = await signupAsUser(env.baseUrl, 'stranger');
    const ws = await createWorkspace(owner);
    const { status } = await getFullProfile(ws, owner, stranger.userId);
    expect(status).toBe(404);
  });

  it('resolves effective* with ws override winning over global', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const member = await signupAsUser(env.baseUrl, 'm');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, member);

    // 전역 displayName/bio 설정.
    await request(env.baseUrl)
      .patch('/me/profile')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ displayName: 'Global Disp', bio: 'global bio' })
      .expect(200);
    // ws 오버라이드 닉네임/About Me 설정.
    await request(env.baseUrl)
      .patch(`/workspaces/${ws}/me/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ nickname: 'WsNick', workspaceBio: 'ws bio' })
      .expect(200);

    const { status, body } = await getFullProfile(ws, owner, member.userId);
    expect(status).toBe(200);
    expect(body.wsNickname).toBe('WsNick');
    expect(body.displayName).toBe('Global Disp');
    expect(body.effectiveDisplayName).toBe('WsNick');
    expect(body.effectiveBio).toBe('ws bio');
    expect(body.bio).toBe('global bio');
    expect(body.systemRole).toBe('MEMBER');
    expect(body.handle).toBeTruthy();
    expect(body.presenceStatus).toBe('offline'); // 미접속 → offline
  });

  it('exposes only custom roles (system role filtered) and presigned avatar URLs', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const member = await signupAsUser(env.baseUrl, 'm');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, member);

    // 커스텀 역할 생성 + 멤버에게 부여(OWNER 가 수행).
    const created = await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Builder', colorHex: '#5865F2' })
      .expect(201);
    const roleId = created.body.id as string;
    await request(env.baseUrl)
      .post(`/workspaces/${ws}/roles/assign`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ roleId, userId: member.userId })
      .expect(204);

    // 전역 아바타 키를 DB 에 직접 심어 presignGet 파생을 검증한다(업로드 finalize 네트워크 회피).
    await env.prisma.user.update({
      where: { id: member.userId },
      data: { avatarKey: `avatars/${member.userId}/a.png` },
    });

    const { status, body } = await getFullProfile(ws, owner, member.userId);
    expect(status).toBe(200);
    expect(body.customRoles).toEqual([{ id: roleId, name: 'Builder', color: '#5865F2' }]);
    expect(body.avatarUrl).toContain(`avatars/${member.userId}/a.png`);
    expect(body.effectiveAvatarUrl).toBe(body.avatarUrl);
  });

  it('masks an expired custom status', async () => {
    const owner = await signupAsUser(env.baseUrl, 'o');
    const member = await signupAsUser(env.baseUrl, 'm');
    const ws = await createWorkspace(owner);
    await inviteAndJoin(ws, owner, member);

    // 만료된 커스텀 상태를 DB 에 직접 심는다(2024 < 고정 시각 2025-01-01).
    await env.prisma.user.update({
      where: { id: member.userId },
      data: {
        customStatus: 'lunch',
        customStatusEmoji: '🍔',
        customStatusExpiresAt: new Date('2024-12-31T00:00:00Z'),
      },
    });

    const { status, body } = await getFullProfile(ws, owner, member.userId);
    expect(status).toBe(200);
    expect(body.customStatus).toBeNull();
    expect(body.customStatusEmoji).toBeNull();
  });
});

describe('S75 FR-PS-14 (C1): workspace channel message list block masking', () => {
  it('masks the body of a blocked author in a workspace channel list', async () => {
    const viewer = await signupAsUser(env.baseUrl, 'viewer');
    const author = await signupAsUser(env.baseUrl, 'author');
    const ws = await createWorkspace(viewer);
    await inviteAndJoin(ws, viewer, author);
    const channelId = await createChannel(ws, viewer);

    const msgId = await sendMessage(ws, channelId, author, 'secret message');

    // viewer 가 author 를 차단(FriendsController block 재사용).
    await request(env.baseUrl)
      .post(`/me/friends/block/${author.userId}`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(201);

    const listed = await request(env.baseUrl)
      .get(`/workspaces/${ws}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);
    const masked = (listed.body.items as Array<{ id: string; content: string | null }>).find(
      (m) => m.id === msgId,
    );
    expect(masked?.content).toBe(BLOCKED_PLACEHOLDER);

    // 작성자 본인에게는 원문이 그대로 보인다(단방향 마스킹).
    const authorView = await request(env.baseUrl)
      .get(`/workspaces/${ws}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .expect(200);
    const own = (authorView.body.items as Array<{ id: string; content: string | null }>).find(
      (m) => m.id === msgId,
    );
    expect(own?.content).toBe('secret message');
  });
});
