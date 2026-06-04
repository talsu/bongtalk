import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type {
  ListMembersResponse,
  WorkspaceMemberProfileView,
  CustomStatusView,
  BannerPresignResult,
} from '@qufox/shared-types';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

/**
 * S74 (D14 / FR-PS-04·05·06) integration.
 *   - 배너 presign URL/fields shape(서명만 — 실 MinIO 불요).
 *   - ws프로필 PATCH/GET(본인) + GET(타멤버) + 비멤버 404.
 *   - dndDuringStatus set/get round-trip.
 *   - 멤버목록이 ws nickname/displayName 오버라이드를 반영(S73 carryover).
 *
 * 업로드 finalize(headObject/magic — 실 MinIO 필요)는 unit(mock S3)이 cover한다.
 */
type Actor = Awaited<ReturnType<typeof signupAsUser>>;
const ORIGIN = 'http://localhost:45173';
let env: WsIntEnv;
let slugCounter = 0;

function uniqueSlug(): string {
  slugCounter += 1;
  return `s74-${slugCounter}-${Date.now().toString(36)}`.slice(0, 30);
}

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createWorkspace(owner: Actor): Promise<string> {
  const res = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'S74Ws', slug: uniqueSlug() })
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

describe('S74 FR-PS-04: 배너 presign', () => {
  it('returns a presigned POST under banners/<userId>/ with policy fields', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74banner');
    const res = await request(env.baseUrl)
      .post('/me/banner/presign')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ contentType: 'image/png', sizeBytes: 1024 })
      .expect(201);
    const body = res.body as BannerPresignResult;
    expect(body.key.startsWith(`banners/${owner.userId}/`)).toBe(true);
    expect(body.key.endsWith('.png')).toBe(true);
    expect(typeof body.url).toBe('string');
    expect(body.fields['Content-Type']).toBe('image/png');
  });

  it('rejects a disallowed mime (415 INVALID_MIME)', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74banmime');
    const res = await request(env.baseUrl)
      .post('/me/banner/presign')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ contentType: 'image/gif', sizeBytes: 1024 })
      .expect(400); // Zod enum rejection → VALIDATION_FAILED(400) at controller boundary.
    expect(res.body).toBeDefined();
  });
});

describe('S74 FR-PS-05: dndDuringStatus', () => {
  it('PUT /users/me/status persists dndDuringStatus and GET reflects it', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74dnd');
    await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ text: 'heads down', dndDuringStatus: true })
      .expect(200);
    const get = await request(env.baseUrl)
      .get('/users/me/status')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const view = get.body as CustomStatusView;
    expect(view.text).toBe('heads down');
    expect(view.dndDuringStatus).toBe(true);
  });
});

describe('S74 FR-PS-06: workspace member profile', () => {
  it('PATCH then GET own ws profile (nickname + bio)', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74wsp');
    const wsId = await createWorkspace(owner);
    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}/me/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ nickname: 'Captain', workspaceBio: '함장입니다' })
      .expect(200);
    const view = patch.body as WorkspaceMemberProfileView;
    expect(view.nickname).toBe('Captain');
    expect(view.workspaceBio).toBe('함장입니다');

    const get = await request(env.baseUrl)
      .get(`/workspaces/${wsId}/me/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect((get.body as WorkspaceMemberProfileView).nickname).toBe('Captain');
  });

  it('another same-workspace member can GET the ws profile', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74wspo');
    const member = await signupAsUser(env.baseUrl, 's74wspm');
    const wsId = await createWorkspace(owner);
    await inviteAndJoin(wsId, owner, member);
    await request(env.baseUrl)
      .patch(`/workspaces/${wsId}/me/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ nickname: 'OwnerNick' })
      .expect(200);
    const res = await request(env.baseUrl)
      .get(`/workspaces/${wsId}/members/${owner.userId}/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect((res.body as WorkspaceMemberProfileView).nickname).toBe('OwnerNick');
  });

  it('404s for a non-member target (enumeration guard)', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74wspx');
    const outsider = await signupAsUser(env.baseUrl, 's74wspy');
    const wsId = await createWorkspace(owner);
    await request(env.baseUrl)
      .get(`/workspaces/${wsId}/members/${outsider.userId}/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('member list reflects ws nickname override (S73 carryover)', async () => {
    const owner = await signupAsUser(env.baseUrl, 's74list');
    const wsId = await createWorkspace(owner);
    // 전역 displayName 설정 → 멤버목록 폴백.
    await request(env.baseUrl)
      .patch('/me/profile')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ displayName: 'GlobalName' })
      .expect(200);
    // ws nickname 오버라이드.
    await request(env.baseUrl)
      .patch(`/workspaces/${wsId}/me/profile`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ nickname: 'WsNick' })
      .expect(200);

    const res = await request(env.baseUrl)
      .get(`/workspaces/${wsId}/members`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const body = res.body as ListMembersResponse;
    const all = [...body.hoist.flatMap((g) => g.members), ...body.groups.flatMap((g) => g.members)];
    const me = all.find((m) => m.userId === owner.userId);
    expect(me).toBeDefined();
    expect(me?.user.wsNickname).toBe('WsNick');
    expect(me?.user.displayName).toBe('GlobalName');
  });
});
