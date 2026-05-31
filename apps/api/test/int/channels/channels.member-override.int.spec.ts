import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ALL_PERMISSIONS, PERMISSIONS } from '@qufox/shared-types';
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

async function createChannel(name: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(seed.admin.accessToken))
    .send({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, type: 'TEXT' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// S12 BLOCKER (S00 carryover): addChannelMember accepted raw allowMask/denyMask
// with no validation, so an ADMIN could inject allowMask:-1 (two's-complement
// all-bits) or an undefined bit (e.g. ADMINISTRATOR / bits 13..62) and grant a
// privilege the bitfield never meant to expose. The masks must be validated as
// non-negative ints inside the defined ALL_PERMISSIONS range.
describe('S12 channel member override — mask validation (privilege-escalation guard)', () => {
  it('rejects allowMask:-1 (all-bits two-complement) with 400 VALIDATION_FAILED', async () => {
    const channelId = await createChannel('ovr-neg');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: -1 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects denyMask:-1 with 400 VALIDATION_FAILED', async () => {
    const channelId = await createChannel('ovr-negd');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, denyMask: -1 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects an out-of-range allowMask bit (beyond ALL_PERMISSIONS) with 400', async () => {
    const channelId = await createChannel('ovr-oob');
    // bit 20 is not part of the defined channel-overwrite bit set.
    const outOfRangeBit = 1 << 20;
    expect((BigInt(outOfRangeBit) & ~ALL_PERMISSIONS) !== 0n).toBe(true);
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: outOfRangeBit });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects a non-integer allowMask with 400', async () => {
    const channelId = await createChannel('ovr-frac');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing/invalid userId with 400', async () => {
    const channelId = await createChannel('ovr-uid');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: 'not-a-uuid', allowMask: 1 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('accepts an in-range allowMask (VIEW_CHANNEL | SEND_MESSAGES) and persists it', async () => {
    const channelId = await createChannel('ovr-ok');
    const goodMask = Number(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: goodMask });
    expect(res.status).toBe(201);
    expect(res.body.override.allowMask).toBe(goodMask);
    expect(res.body.override.principalId).toBe(seed.member.userId);
  });

  // review S12 BLOCKER-1: the override allowMask/denyMask columns are
  // interpreted by ChannelAccessService against the ENFORCEMENT bitfield
  // (auth/permissions ALL_PERMISSIONS). S15 expanded the enforcement set to
  // 0x1FF (bits 0..8) by adding BYPASS_SLOWMODE=0x100, so the "inside the
  // shared catalog but outside enforcement" probe now uses 0x800
  // (USE_EXTERNAL_EMOJI) — it exists in the shared-types PERMISSIONS catalog
  // (zod passes it) but is OUTSIDE the enforcement set, so the controller's
  // range check (mask > ALL_PERMISSIONS) rejects it as garbage.
  it('rejects a bit inside the shared catalog but outside the enforcement set (0x800) with 400', async () => {
    const channelId = await createChannel('ovr-enf');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: 0x800 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('accepts the full enforcement mask (0xFF) at the boundary', async () => {
    const channelId = await createChannel('ovr-ff');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: 0xff });
    expect(res.status).toBe(201);
    expect(res.body.override.allowMask).toBe(0xff);
  });
});
