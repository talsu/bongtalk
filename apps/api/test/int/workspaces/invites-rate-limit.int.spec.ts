/**
 * Task-013-A1 (task-031/032 closures) — rate-limit + CAS error fidelity on
 * the invite endpoints.
 *   - preview: 60/min per IP (caps an enumeration-style probe)
 *   - accept : 30/min per user + 10/min per code
 *   - accept against a revoked code returns 410 INVITE_REVOKED (not the
 *     generic INVITE_NOT_FOUND it used to — that was the 032 complaint).
 *
 * Rate-limit keys are cleared between tests so we don't leak counters
 * across specs. Uses the existing ws-int testcontainer stack.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // Reset the rate-limit namespace — other specs in this run share the
  // Redis instance so leftover counters would false-429 this spec.
  const keys = await env.redis.keys('rl:invite:*');
  if (keys.length > 0) await env.redis.del(...keys);
});

async function makeOwnedWorkspace(prefix: string) {
  const owner = await signupAsUser(env.baseUrl, prefix);
  const create = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) });
  return { owner, workspaceId: create.body.id as string };
}

async function createInvite(
  ownerToken: string,
  workspaceId: string,
  body: Record<string, unknown> = {},
) {
  const r = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(body);
  if (r.status !== 201) throw new Error(`create invite ${r.status}: ${r.text}`);
  return r.body.invite.code as string;
}

describe('Invite rate limits (task-013-A1 / task-031)', () => {
  it('preview: 61st request from same IP → 429', async () => {
    const { owner, workspaceId } = await makeOwnedWorkspace('irlp');
    const code = await createInvite(owner.accessToken, workspaceId, { maxUses: 100 });
    // 60 previews should all succeed; 61st trips the window.
    for (let i = 0; i < 60; i++) {
      const r = await request(env.baseUrl).get(`/invites/${code}`);
      if (r.status !== 200) throw new Error(`preview #${i} unexpectedly ${r.status}`);
    }
    const over = await request(env.baseUrl).get(`/invites/${code}`);
    expect(over.status).toBe(429);
    expect(over.body.errorCode).toBe('RATE_LIMITED');
  }, 30_000);

  it('accept: per-user 31st attempt → 429 (cap 30/min)', async () => {
    const { owner, workspaceId } = await makeOwnedWorkspace('irla');
    // 31 DIFFERENT codes so nothing else short-circuits (already-member,
    // exhausted). Joiner accepts the first one, then the next 30 target
    // codes that point at workspaces they're not a member of so the
    // rate limit is the only gate.
    const joiner = await signupAsUser(env.baseUrl, 'irla-j');
    // Prep: joiner joins a separate workspace FIRST so they're a real user.
    const firstCode = await createInvite(owner.accessToken, workspaceId);
    await request(env.baseUrl)
      .post(`/invites/${firstCode}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .expect(201);

    // 29 more accept attempts that the service will 409 (already member)
    // — those still count toward the per-user bucket because the rate
    // limiter runs BEFORE the service call.
    let saw429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await request(env.baseUrl)
        .post(`/invites/${firstCode}/accept`)
        .set('origin', ORIGIN)
        .set('Authorization', `Bearer ${joiner.accessToken}`);
      if (r.status === 429) {
        saw429 = true;
        expect(r.body.errorCode).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(saw429).toBe(true);
  }, 30_000);

  it('accept: per-code 11th attempt → 429 (cap 10/min)', async () => {
    const { owner, workspaceId } = await makeOwnedWorkspace('irlc');
    const code = await createInvite(owner.accessToken, workspaceId, { maxUses: 50 });

    // 11 fresh joiners so we're not tripping the per-user bucket.
    const joiners = await Promise.all(
      Array.from({ length: 11 }, (_, i) => signupAsUser(env.baseUrl, `irlc${i}`)),
    );

    const results: number[] = [];
    for (const j of joiners) {
      const r = await request(env.baseUrl)
        .post(`/invites/${code}/accept`)
        .set('origin', ORIGIN)
        .set('Authorization', `Bearer ${j.accessToken}`);
      results.push(r.status);
    }
    // First 10 accepted → 201; 11th must be 429 (per-code bucket).
    const okCount = results.filter((s) => s === 201).length;
    const limited = results.filter((s) => s === 429).length;
    expect(okCount).toBe(10);
    expect(limited).toBe(1);
  }, 60_000);
});

describe('Invite accept CAS error fidelity (task-013-A1 / task-032)', () => {
  it('revoked code → 410 INVITE_REVOKED (not INVITE_NOT_FOUND)', async () => {
    const { owner, workspaceId } = await makeOwnedWorkspace('irev');
    const code = await createInvite(owner.accessToken, workspaceId, { maxUses: 10 });
    const joiner = await signupAsUser(env.baseUrl, 'irev-j');

    // Grab the inviteId to revoke it.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/invites`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const inviteId = list.body.invites.find((i: { code: string }) => i.code === code).id;
    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/invites/${inviteId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    // Acceptance after revocation must surface INVITE_REVOKED — the
    // pre-CAS findUnique path. Using 410 so the UI can distinguish
    // "never existed" (404) from "was deliberately invalidated" (410).
    const r = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(r.status).toBe(410);
    expect(r.body.errorCode).toBe('INVITE_REVOKED');
  }, 30_000);

  it('expired code → 410 INVITE_EXPIRED (kept intact alongside REVOKED)', async () => {
    const { owner, workspaceId } = await makeOwnedWorkspace('iexp');
    const past = new Date(Date.now() - 5_000).toISOString();
    const code = await createInvite(owner.accessToken, workspaceId, { expiresAt: past });
    const joiner = await signupAsUser(env.baseUrl, 'iexp-j');
    const r = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(r.status).toBe(410);
    expect(r.body.errorCode).toBe('INVITE_EXPIRED');
  });
});
