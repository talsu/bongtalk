import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser, STRONG_PW } from './helpers';
import { randomUUID } from 'node:crypto';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

let counter = 0;
const uniqueSlug = (prefix = 'acme') => {
  counter += 1;
  return `${prefix}-${counter}-${Date.now().toString(36)}`.slice(0, 30);
};

describe('POST /workspaces', () => {
  it('creates workspace + makes creator the OWNER', async () => {
    const user = await signupAsUser(env.baseUrl, 'wc');
    const slug = uniqueSlug();
    const res = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Acme', slug });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(slug);
    expect(res.body.ownerId).toBe(user.userId);
  });

  it('rejects reserved slug', async () => {
    const user = await signupAsUser(env.baseUrl, 'wr');
    const res = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'X', slug: 'admin' });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('WORKSPACE_SLUG_RESERVED');
  });

  it('rejects duplicate slug', async () => {
    const user = await signupAsUser(env.baseUrl, 'wd');
    const slug = uniqueSlug('dup');
    await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'A', slug })
      .expect(201);
    const res = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'B', slug });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('WORKSPACE_SLUG_TAKEN');
  });
});

describe('GET /workspaces/:id and membership hiding', () => {
  it('returns 404 WORKSPACE_NOT_MEMBER when caller is not a member (IDOR defence)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'og');
    const outsider = await signupAsUser(env.baseUrl, 'out');
    const createRes = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Private', slug: uniqueSlug('priv') });
    const id = createRes.body.id;
    const res = await request(env.baseUrl)
      .get(`/workspaces/${id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('WORKSPACE_NOT_MEMBER');
  });

  it('returns 404 WORKSPACE_NOT_FOUND when workspace id does not exist', async () => {
    const user = await signupAsUser(env.baseUrl, 'un');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${randomUUID()}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('WORKSPACE_NOT_FOUND');
  });
});

describe('Soft delete + restore + purge', () => {
  it('DELETE returns 202 with deleteAt 30d out and workspace disappears from list', async () => {
    const user = await signupAsUser(env.baseUrl, 'sd');
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'DelMe', slug: uniqueSlug('del') });
    const id = create.body.id;
    const del = await request(env.baseUrl)
      .delete(`/workspaces/${id}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(del.status).toBe(202);
    expect(del.body.deleteAt).toBeTruthy();
    const list = await request(env.baseUrl)
      .get('/workspaces')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(list.body.workspaces.some((w: { id: string }) => w.id === id)).toBe(false);
  });

  it('POST /workspaces/:id/restore un-deletes within grace window', async () => {
    const user = await signupAsUser(env.baseUrl, 'rs');
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Restore', slug: uniqueSlug('rst') });
    const id = create.body.id;
    await request(env.baseUrl)
      .delete(`/workspaces/${id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(202);
    const restore = await request(env.baseUrl)
      .post(`/workspaces/${id}/restore`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(restore.status).toBe(201);
    expect(restore.body.deletedAt).toBeNull();
  });
});

describe('Transfer ownership — atomicity', () => {
  it('owner → target; old owner becomes ADMIN; single OWNER invariant holds', async () => {
    const owner = await signupAsUser(env.baseUrl, 'too');
    const other = await signupAsUser(env.baseUrl, 'tot');

    // Create workspace + invite other in
    const createRes = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'TransferMe', slug: uniqueSlug('xfer') });
    const wsId = createRes.body.id;

    const inv = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 1 });
    expect(inv.status).toBe(201);
    const code = inv.body.invite.code;

    const accept = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(accept.status).toBe(201);

    const transfer = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/transfer-ownership`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      // S65 (FR-W13): 양도는 OWNER 비밀번호 재확인을 강제하므로 password 를 함께 보낸다.
      .send({ toUserId: other.userId, password: STRONG_PW });
    expect(transfer.status).toBe(200);

    // Confirm roles from the server's perspective.
    const meAsOwner = await request(env.baseUrl)
      .get(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(meAsOwner.body.myRole).toBe('ADMIN');
    const meAsOther = await request(env.baseUrl)
      .get(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(meAsOther.body.myRole).toBe('OWNER');

    // Count OWNERs directly via Prisma — invariant check.
    const owners = await env.prisma.workspaceMember.count({
      where: { workspaceId: wsId, role: 'OWNER' },
    });
    expect(owners).toBe(1);
  });

  // S65 (FR-W13 · ★결정 C): 비밀번호 재확인 게이트.
  it('rejects transfer with a wrong password (403 AUTH_INVALID_CREDENTIALS)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'tpw');
    const other = await signupAsUser(env.baseUrl, 'tpwo');
    const createRes = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'PwGate', slug: uniqueSlug('pwg') });
    const wsId = createRes.body.id;

    const inv = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 1 });
    await request(env.baseUrl)
      .post(`/invites/${inv.body.invite.code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(201);

    const transfer = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/transfer-ownership`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ toUserId: other.userId, password: 'definitely-not-the-password' });
    expect(transfer.status).toBe(401);
    expect(transfer.body.errorCode).toBe('AUTH_INVALID_CREDENTIALS');

    // Ownership must be unchanged.
    const me = await request(env.baseUrl)
      .get(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(me.body.myRole).toBe('OWNER');
  });

  // S65 fix-forward (security A-1 = HIGH/BLOCKER): 양도 엔드포인트는 비밀번호
  // brute-force 표면이므로 5회/5분/OWNER 로 rate-limit 한다. 6회째는 429.
  it('rate-limits transfer at 5 per 5 minutes per owner (6th → 429)', async () => {
    const owner = await signupAsUser(env.baseUrl, 'trl');
    const other = await signupAsUser(env.baseUrl, 'trlo');
    const createRes = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'RlGate', slug: uniqueSlug('trl') });
    const wsId = createRes.body.id;

    const inv = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 1 });
    await request(env.baseUrl)
      .post(`/invites/${inv.body.invite.code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(201);

    // 5 wrong-password attempts each consume a rate-limit hit but never
    // transfer (401). The rate-limit gate runs before the password check.
    for (let i = 0; i < 5; i += 1) {
      const r = await request(env.baseUrl)
        .post(`/workspaces/${wsId}/transfer-ownership`)
        .set('origin', ORIGIN)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ toUserId: other.userId, password: `wrong-${i}` });
      expect(r.status).toBe(401);
    }
    // 6th attempt is over cap (max=5) → 429 with Retry-After.
    const limited = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/transfer-ownership`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ toUserId: other.userId, password: STRONG_PW });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    // Ownership must be unchanged — the 429 blocked the valid attempt too.
    const me = await request(env.baseUrl)
      .get(`/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(me.body.myRole).toBe('OWNER');
  });
});

// S65 (FR-W01): 워크스페이스 생성 시 #general 자동 생성 + joinMode + 단일 트랜잭션.
describe('POST /workspaces — #general + joinMode (FR-W01)', () => {
  it('auto-creates #general (isDefault) and sets workspace.defaultChannelId', async () => {
    const user = await signupAsUser(env.baseUrl, 'gen');
    const res = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'WithGeneral', slug: uniqueSlug('gen') });
    expect(res.status).toBe(201);
    const wsId = res.body.id;
    expect(res.body.defaultChannelId).toBeTruthy();
    expect(res.body.joinMode).toBe('PRIVATE');

    const channels = await env.prisma.channel.findMany({ where: { workspaceId: wsId } });
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('general');
    expect(channels[0].isDefault).toBe(true);
    expect(res.body.defaultChannelId).toBe(channels[0].id);
  });

  it('persists joinMode=APPLY and a normalized email-domain whitelist', async () => {
    const user = await signupAsUser(env.baseUrl, 'jm');
    const res = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        name: 'ApplyWs',
        slug: uniqueSlug('apply'),
        joinMode: 'APPLY',
        emailDomains: ['example.com', 'example.com', 'corp.io'],
      });
    expect(res.status).toBe(201);
    expect(res.body.joinMode).toBe('APPLY');
    const ws = await env.prisma.workspace.findUnique({ where: { id: res.body.id } });
    expect(ws?.joinMode).toBe('APPLY');
    expect([...(ws?.emailDomains ?? [])].sort()).toEqual(['corp.io', 'example.com']);
  });

  it('rolls back the whole create on a duplicate slug — no orphan #general channel', async () => {
    const user = await signupAsUser(env.baseUrl, 'rb');
    const slug = uniqueSlug('rb');
    await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'First', slug })
      .expect(201);
    const dup = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Second', slug });
    expect(dup.status).toBe(409);
    // Exactly ONE #general should exist for this slug (the first workspace).
    const ws = await env.prisma.workspace.findUnique({ where: { slug } });
    const channels = await env.prisma.channel.findMany({ where: { workspaceId: ws!.id } });
    expect(channels).toHaveLength(1);
  });
});

// S65 (FR-W19): 기본 채널 변경 — 공개 채널만·isDefault 토글·단일 트랜잭션.
describe('PATCH /workspaces/:id/default-channel (FR-W19)', () => {
  it('moves the default to another public channel and flips isDefault', async () => {
    const user = await signupAsUser(env.baseUrl, 'dc');
    const createRes = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'DefChan', slug: uniqueSlug('dc') });
    const wsId = createRes.body.id;
    const generalId = createRes.body.defaultChannelId;

    const second = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/channels`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'lounge', type: 'TEXT' });
    expect(second.status).toBe(201);
    const secondId = second.body.id;

    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}/default-channel`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ defaultChannelId: secondId });
    expect(patch.status).toBe(200);
    expect(patch.body.defaultChannelId).toBe(secondId);

    const channels = await env.prisma.channel.findMany({ where: { workspaceId: wsId } });
    const byId = new Map(channels.map((c) => [c.id, c]));
    expect(byId.get(generalId)?.isDefault).toBe(false);
    expect(byId.get(secondId)?.isDefault).toBe(true);
  });

  it('rejects a private channel as default (422 WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC)', async () => {
    const user = await signupAsUser(env.baseUrl, 'dcp');
    const createRes = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'DefChanPriv', slug: uniqueSlug('dcp') });
    const wsId = createRes.body.id;

    const priv = await request(env.baseUrl)
      .post(`/workspaces/${wsId}/channels`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'secret', type: 'TEXT', isPrivate: true });
    expect(priv.status).toBe(201);

    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${wsId}/default-channel`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ defaultChannelId: priv.body.id });
    expect(patch.status).toBe(422);
    expect(patch.body.errorCode).toBe('WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC');
  });
});
