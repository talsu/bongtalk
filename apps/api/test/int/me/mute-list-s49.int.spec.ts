import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  bearer,
  type ChIntEnv,
  ORIGIN,
  seedWorkspaceWithRoles,
  setupChIntEnv,
  STRONG_PW,
} from '../channels/helpers';

/**
 * S49 (D06 / FR-MN-17): "현재 뮤트 중" 목록 API 회귀(실 DB).
 *
 * 핵심:
 *   - GET /me/mutes 가 Channel/Workspace join 으로 channelName·workspaceId·
 *     workspaceName 을 함께 내려준다(보강).
 *   - **삭제 채널은 목록에서 제외**된다(Channel.deletedAt IS NOT NULL).
 *   - GET /me/server-mutes 가 활성 서버 뮤트만(isMuted=true, 미만료) Workspace
 *     join 해 반환한다(workspaceName·level·muteUntil).
 *   - 만료 서버 뮤트는 query-time 에 제외된다.
 *   - 본인 뮤트만(다른 사용자 뮤트 비노출).
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

async function muteChannel(channelId: string, token: string, until: string | null): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/me/mutes/channels/${channelId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(until === null ? {} : { until });
  if (res.status !== 200) throw new Error(`mute failed: ${res.status} ${res.text}`);
}

describe('GET /me/mutes (S49 FR-MN-17 — 보강 + 삭제채널 제외)', () => {
  it('channelName·workspaceId·workspaceName 보강', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'general-s49');
    await muteChannel(chId, owner.accessToken, null);

    const res = await request(env.baseUrl)
      .get('/me/mutes')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<Record<string, unknown>>).find(
      (i) => i.channelId === chId,
    );
    expect(item).toBeDefined();
    expect(item?.channelName).toBe('general-s49');
    expect(item?.workspaceId).toBe(workspaceId);
    expect(item?.workspaceName).toBe('ChWs');
    expect(item?.mutedUntil).toBeNull();
    expect(typeof item?.createdAt).toBe('string');
  });

  it('삭제 채널은 목록에서 제외', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    const liveCh = await createChannel(workspaceId, owner.accessToken, 'live-s49');
    const deadCh = await createChannel(workspaceId, owner.accessToken, 'dead-s49');
    await muteChannel(liveCh, owner.accessToken, null);
    await muteChannel(deadCh, owner.accessToken, null);

    // 삭제 채널 soft-delete (OWNER).
    const del = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${deadCh}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(del.status).toBe(202);

    const res = await request(env.baseUrl)
      .get('/me/mutes')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    const ids = (res.body.items as Array<{ channelId: string }>).map((i) => i.channelId);
    expect(ids).toContain(liveCh);
    expect(ids).not.toContain(deadCh);
  });

  it('본인 뮤트만 — 다른 사용자 뮤트 비노출', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const chId = await createChannel(workspaceId, owner.accessToken, 'shared-s49');
    await muteChannel(chId, owner.accessToken, null);

    const res = await request(env.baseUrl)
      .get('/me/mutes')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    const ids = (res.body.items as Array<{ channelId: string }>).map((i) => i.channelId);
    expect(ids).not.toContain(chId);
  });
});

describe('GET /me/server-mutes (S49 FR-MN-17)', () => {
  it('활성 서버 뮤트만 Workspace join — workspaceName·level·muteUntil', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    const put = await request(env.baseUrl)
      .put(`/workspaces/${workspaceId}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ isMuted: true, muteDuration: 'forever', level: 'NOTHING' });
    expect(put.status).toBe(200);

    const res = await request(env.baseUrl)
      .get('/me/server-mutes')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<Record<string, unknown>>).find(
      (i) => i.workspaceId === workspaceId,
    );
    expect(item).toBeDefined();
    expect(item?.workspaceName).toBe('ChWs');
    expect(item?.level).toBe('NOTHING');
    expect(item?.muteUntil).toBeNull();
    expect('workspaceIconUrl' in (item as object)).toBe(true);
  });

  it('비뮤트 서버는 목록에 없음', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .get('/me/server-mutes')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    const ids = (res.body.items as Array<{ workspaceId: string }>).map((i) => i.workspaceId);
    expect(ids).not.toContain(workspaceId);
  });

  it('만료 서버 뮤트는 query-time 에 제외(15m 뒤 시계 진행)', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    await request(env.baseUrl)
      .put(`/workspaces/${workspaceId}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ isMuted: true, muteDuration: '15m' });

    // 16분 뒤로 시계를 진행 — muteUntil(=00:15) < now 가 되어 활성 필터에서 빠진다.
    // 기존 access token 은 TTL 15분이라 이 시점에 만료되므로, 재로그인으로 그 시각에
    // 유효한 새 토큰을 발급받아 query-time 만료 판정만 격리 검증한다.
    vi.setSystemTime(new Date('2025-01-01T00:16:00Z'));
    const relogin = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', ORIGIN)
      .send({ email: owner.email, password: STRONG_PW });
    expect(relogin.status).toBe(200);
    const freshToken = relogin.body.accessToken as string;

    const res = await request(env.baseUrl)
      .get('/me/server-mutes')
      .set('origin', ORIGIN)
      .set(bearer(freshToken));
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ workspaceId: string }>).map((i) => i.workspaceId);
    expect(ids).not.toContain(workspaceId);
  });

  it('DELETE /workspaces/:id/notification-preferences 로 해제 시 목록에서 사라짐', async () => {
    const { workspaceId, owner } = await seedWorkspaceWithRoles(env.baseUrl);
    await request(env.baseUrl)
      .put(`/workspaces/${workspaceId}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ isMuted: true, muteDuration: 'forever' });

    const before = await request(env.baseUrl)
      .get('/me/server-mutes')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(
      (before.body.items as Array<{ workspaceId: string }>).some(
        (i) => i.workspaceId === workspaceId,
      ),
    ).toBe(true);

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/notification-preferences`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(del.status).toBe(200);

    const after = await request(env.baseUrl)
      .get('/me/server-mutes')
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(
      (after.body.items as Array<{ workspaceId: string }>).some(
        (i) => i.workspaceId === workspaceId,
      ),
    ).toBe(false);
  });
});
