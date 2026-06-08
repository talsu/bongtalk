/**
 * FR-CH-03 (065) — 기본 채널 삭제/보관 보호.
 *
 * 기본 채널(Workspace.defaultChannelId · Channel.isDefault=true)은 가입자 랜딩
 * 채널이라 항상 존재·접근 가능해야 한다. softDelete / archive 가 isDefault 가드로
 * DEFAULT_CHANNEL_PROTECTED(409)를 던지는지, 그리고 updateDefaultChannel 로 기본을
 * 다른 공개 채널로 옮긴 뒤엔 옛 기본 채널을 삭제할 수 있는지(가드는 "현재 기본"만
 * 차단) 회귀고정한다. workspaceId 스코프(타 워크스페이스 채널 누출 방지)도 검증한다.
 *
 * seedWorkspaceWithRoles 는 자동 #general 을 prisma 로 직접 제거하므로(가드 우회),
 * 이 스펙은 채널을 직접 만들고 PATCH /default-channel 로 기본을 명시 지정해 테스트한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ChIntEnv, ORIGIN, setupChIntEnv, seedWorkspaceWithRoles, bearer } from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
  seed = await seedWorkspaceWithRoles(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/** OWNER 가 채널을 만들고(공개 TEXT), 그 채널을 워크스페이스 기본으로 지정한다. */
async function createDefaultChannel(name: string): Promise<string> {
  const { workspaceId, owner } = seed;
  const created = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(owner.accessToken))
    .send({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, type: 'TEXT' });
  expect(created.status).toBe(201);
  const channelId = created.body.id as string;
  const patched = await request(env.baseUrl)
    .patch(`/workspaces/${workspaceId}/default-channel`)
    .set('origin', ORIGIN)
    .set(bearer(owner.accessToken))
    .send({ defaultChannelId: channelId });
  expect(patched.status).toBe(200);
  return channelId;
}

describe('FR-CH-03 · 기본 채널 삭제/보관 보호', () => {
  it('기본 채널 삭제(DELETE)는 409 DEFAULT_CHANNEL_PROTECTED 로 거부된다', async () => {
    const { workspaceId, owner } = seed;
    const defaultId = await createDefaultChannel('frch03-del');

    const res = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${defaultId}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('DEFAULT_CHANNEL_PROTECTED');

    // 거부됐으므로 채널은 여전히 살아 있어야 한다.
    const one = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${defaultId}`)
      .set(bearer(owner.accessToken));
    expect(one.status).toBe(200);
    expect(one.body.deletedAt ?? null).toBeNull();
  });

  it('기본 채널 보관(archive)은 409 DEFAULT_CHANNEL_PROTECTED 로 거부된다', async () => {
    const { workspaceId, owner } = seed;
    const defaultId = await createDefaultChannel('frch03-arc');

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${defaultId}/archive`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('DEFAULT_CHANNEL_PROTECTED');

    const one = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${defaultId}`)
      .set(bearer(owner.accessToken));
    expect(one.status).toBe(200);
    expect(one.body.archivedAt ?? null).toBeNull();
  });

  it('비기본 채널 삭제는 정상 처리된다(202)', async () => {
    const { workspaceId, owner } = seed;
    // 기본 채널 하나 + 비기본 채널 하나를 둔다.
    await createDefaultChannel('frch03-keep');
    const created = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: `frch03-plain-${Math.random().toString(36).slice(2, 8)}`, type: 'TEXT' });
    expect(created.status).toBe(201);
    const plainId = created.body.id as string;

    const res = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${plainId}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(res.status).toBe(202);
  });

  it('기본을 다른 채널로 옮긴 뒤엔 옛 기본 채널을 삭제할 수 있다', async () => {
    const { workspaceId, owner } = seed;
    // 옛 기본 채널.
    const oldDefault = await createDefaultChannel('frch03-old');
    // 새 공개 채널을 만들어 기본을 이관한다.
    const newCh = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ name: `frch03-new-${Math.random().toString(36).slice(2, 8)}`, type: 'TEXT' });
    expect(newCh.status).toBe(201);
    const newId = newCh.body.id as string;

    // 옛 기본은 아직 기본이라 삭제 거부.
    const blocked = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${oldDefault}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(blocked.status).toBe(409);
    expect(blocked.body.errorCode).toBe('DEFAULT_CHANNEL_PROTECTED');

    // 기본을 새 채널로 이관.
    const patched = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/default-channel`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ defaultChannelId: newId });
    expect(patched.status).toBe(200);

    // 이제 옛 기본은 더 이상 기본이 아니므로 삭제 가능.
    const ok = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${oldDefault}`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(ok.status).toBe(202);
  });

  it('타 워크스페이스 OWNER 는 이 워크스페이스 기본 채널을 건드릴 수 없다(스코프 격리)', async () => {
    const { workspaceId } = seed;
    const defaultId = await createDefaultChannel('frch03-scope');

    // 별도 워크스페이스 + OWNER.
    const other = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${defaultId}`)
      .set('origin', ORIGIN)
      .set(bearer(other.owner.accessToken));
    // ChannelAccessGuard / WorkspaceMemberGuard 가 비멤버를 먼저 막으므로 403/404 계열이며,
    // 어느 경우든 기본 채널은 삭제되지 않는다.
    expect([401, 403, 404]).toContain(res.status);
    expect(res.body.errorCode).not.toBe('DEFAULT_CHANNEL_PROTECTED');

    const one = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${defaultId}`)
      .set(bearer(seed.owner.accessToken));
    expect(one.status).toBe(200);
    expect(one.body.deletedAt ?? null).toBeNull();
  });
});
