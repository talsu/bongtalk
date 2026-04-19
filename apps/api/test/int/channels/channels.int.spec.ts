import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  ChIntEnv,
  ORIGIN,
  setupChIntEnv,
  seedWorkspaceWithRoles,
  bearer,
} from './helpers';

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

const ch = (name: string) => ({
  name: `${name}-${Math.random().toString(36).slice(2, 8)}`,
  type: 'TEXT' as const,
});

describe('Channels CRUD', () => {
  it('creates → lists → fetches a channel (ADMIN)', async () => {
    const { workspaceId, admin } = seed;
    const created = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send(ch('crud-1'));
    expect(created.status).toBe(201);
    expect(created.body.name).toMatch(/^crud-1-/);
    const channelId = created.body.id;

    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels`)
      .set(bearer(admin.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.uncategorized.some((c: { id: string }) => c.id === channelId)).toBe(true);

    const one = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${channelId}`)
      .set(bearer(admin.accessToken));
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(channelId);
  });

  it('rejects reserved names with 422 CHANNEL_NAME_INVALID', async () => {
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ name: 'everyone', type: 'TEXT' });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('CHANNEL_NAME_INVALID');
  });

  it('rejects unimplemented types (VOICE) with 422 CHANNEL_TYPE_NOT_IMPLEMENTED', async () => {
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ name: `voice-${Date.now().toString(36)}`, type: 'VOICE' });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('CHANNEL_TYPE_NOT_IMPLEMENTED');
  });

  it('rejects duplicate channel name with 409 CHANNEL_NAME_TAKEN', async () => {
    const name = `dup-${Date.now().toString(36)}`;
    const first = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ name, type: 'TEXT' });
    expect(first.status).toBe(201);
    const second = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ name, type: 'TEXT' });
    expect(second.status).toBe(409);
    expect(second.body.errorCode).toBe('CHANNEL_NAME_TAKEN');
  });
});

describe('Channels soft delete + restore + archive', () => {
  it('soft delete hides channel from list; restore brings it back', async () => {
    const { workspaceId, owner, admin } = seed;
    const created = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send(ch('deletable'));
    const channelId = created.body.id;

    const del = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/channels/${channelId}`)
      .set(bearer(owner.accessToken));
    expect(del.status).toBe(202);

    const listAfter = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels`)
      .set(bearer(admin.accessToken));
    expect(listAfter.body.uncategorized.some((c: { id: string }) => c.id === channelId)).toBe(false);

    const restore = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/restore`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(restore.status).toBe(201);

    const listAgain = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels`)
      .set(bearer(admin.accessToken));
    expect(listAgain.body.uncategorized.some((c: { id: string }) => c.id === channelId)).toBe(true);
  });

  it('archive blocks mutating updates; unarchive restores', async () => {
    const { workspaceId, admin } = seed;
    const created = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send(ch('archivable'));
    const channelId = created.body.id;

    const archive = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/archive`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken));
    expect(archive.status).toBe(201);

    const patchArchived = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ topic: 'nope' });
    expect(patchArchived.status).toBe(409);
    expect(patchArchived.body.errorCode).toBe('CHANNEL_ARCHIVED');

    const unarchive = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/unarchive`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken));
    expect(unarchive.status).toBe(201);

    const patchAfter = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ topic: 'ok' });
    expect(patchAfter.status).toBe(200);
    expect(patchAfter.body.topic).toBe('ok');
  });
});

describe('Categories + reorder', () => {
  it('creates a category, moves a channel into it, and reorders within the category', async () => {
    const { workspaceId, admin } = seed;
    // Create two channels + one category
    const a = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send(ch('re-a'));
    const b = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send(ch('re-b'));
    const cat = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/categories`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ name: `Cat ${Date.now().toString(36)}` });

    const move1 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${a.body.id}/move`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ categoryId: cat.body.id });
    expect(move1.status).toBe(201);
    expect(move1.body.categoryId).toBe(cat.body.id);

    const move2 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${b.body.id}/move`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ categoryId: cat.body.id });
    expect(move2.status).toBe(201);

    const positionedBefore = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${b.body.id}/move`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ categoryId: cat.body.id, beforeId: a.body.id });
    expect(positionedBefore.status).toBe(201);

    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels`)
      .set(bearer(admin.accessToken));
    const catOut = list.body.categories.find((c: { id: string }) => c.id === cat.body.id);
    expect(catOut.channels.map((c: { id: string }) => c.id)).toEqual([b.body.id, a.body.id]);
  });
});
