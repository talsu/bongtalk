/**
 * Task-016-C-2: BetaInviteRequiredGuard on POST /auth/signup.
 *   - flag off (default in test env) → signup works without inviteCode.
 *   - flag on + missing inviteCode → 403 BETA_INVITE_REQUIRED.
 *   - flag on + invalid inviteCode → 403 BETA_INVITE_REQUIRED (specific message).
 *   - flag on + valid inviteCode → signup succeeds (invite NOT consumed).
 *
 * The flag is read from process.env at each request, so toggling it
 * between tests doesn't require restarting the Nest app — just reset
 * before each spec.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser, STRONG_PW } from '../workspaces/helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
  delete process.env.BETA_INVITE_REQUIRED;
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  delete process.env.BETA_INVITE_REQUIRED;
});

async function signupAttempt(body: Record<string, unknown>) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  return request(env.baseUrl)
    .post('/auth/signup')
    .set('origin', ORIGIN)
    .send({
      email: `bg-${stamp}@qufox.dev`,
      username: `bg${stamp}`,
      password: STRONG_PW,
      ...body,
    });
}

describe('BetaInviteRequiredGuard (task-016-C-2)', () => {
  it('flag off → signup without inviteCode succeeds', async () => {
    const r = await signupAttempt({});
    expect(r.status).toBe(201);
    expect(r.body.user).toBeTruthy();
  });

  it('flag on + no inviteCode → 403 BETA_INVITE_REQUIRED', async () => {
    process.env.BETA_INVITE_REQUIRED = 'true';
    const r = await signupAttempt({});
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('BETA_INVITE_REQUIRED');
  });

  it('flag on + unknown inviteCode → 403 BETA_INVITE_REQUIRED', async () => {
    process.env.BETA_INVITE_REQUIRED = 'true';
    const r = await signupAttempt({ inviteCode: 'does-not-exist' });
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('BETA_INVITE_REQUIRED');
  });

  it('flag on + valid inviteCode → signup succeeds, invite NOT consumed', async () => {
    // Seed a workspace + invite with the flag OFF so we can bootstrap.
    const owner = await signupAsUser(env.baseUrl, 'bgowner');
    const ws = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'BG', slug: `bg-${Date.now().toString(36)}` });
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${ws.body.id}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code as string;

    // Flag ON, signup with the valid code.
    process.env.BETA_INVITE_REQUIRED = 'true';
    const r = await signupAttempt({ inviteCode: code });
    expect(r.status).toBe(201);

    // Invite usage count unchanged — signup does NOT consume.
    const invRow = await env.prisma.invite.findUnique({ where: { code } });
    expect(invRow?.usedCount).toBe(0);
  });

  it('flag on + revoked inviteCode → 403 BETA_INVITE_REQUIRED', async () => {
    const owner = await signupAsUser(env.baseUrl, 'bgrev');
    const ws = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'BG', slug: `bgr-${Date.now().toString(36)}` });
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${ws.body.id}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code as string;
    const invId = inv.body.invite.id as string;
    await request(env.baseUrl)
      .delete(`/workspaces/${ws.body.id}/invites/${invId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    process.env.BETA_INVITE_REQUIRED = 'true';
    const r = await signupAttempt({ inviteCode: code });
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe('BETA_INVITE_REQUIRED');
  });
});
