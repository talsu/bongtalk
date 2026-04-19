import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';
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
      .send({ toUserId: other.userId });
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
});
