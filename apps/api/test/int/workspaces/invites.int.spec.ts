/**
 * Invite lifecycle + race-safety tests.
 * The "race" case fires 10 concurrent accepts at a maxUses=3 invite and
 * asserts exactly 3 succeed. Required for evals/tasks/006.
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

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function setupOwnerAndWs(prefix: string) {
  const owner = await signupAsUser(env.baseUrl, prefix);
  const create = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) });
  return { owner, workspaceId: create.body.id as string };
}

describe('Invite preview / expiry / exhaustion', () => {
  it('preview works anonymously for a valid invite', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('ipa');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 2 });
    const code = inv.body.invite.code;

    const preview = await request(env.baseUrl).get(`/invites/${code}`);
    expect(preview.status).toBe(200);
    expect(preview.body.workspace.name).toBe('ipa');
    expect(preview.body.usesRemaining).toBe(2);
  });

  it('returns 410 INVITE_EXPIRED on past expiresAt', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('iex');
    const past = new Date(Date.now() - 1000).toISOString();
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ expiresAt: past });
    const code = inv.body.invite.code;
    const preview = await request(env.baseUrl).get(`/invites/${code}`);
    expect(preview.status).toBe(410);
    expect(preview.body.errorCode).toBe('INVITE_EXPIRED');
  });

  it('returns 409 WORKSPACE_ALREADY_MEMBER when accepting a second time', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('iam');
    const joiner = await signupAsUser(env.baseUrl, 'iam2');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code;

    await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .expect(201);

    const again = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(again.status).toBe(409);
    expect(again.body.errorCode).toBe('WORKSPACE_ALREADY_MEMBER');
  });
});

describe('Invite accept — race-safe under concurrent use (eval 006)', () => {
  it('10 concurrent accepts on maxUses=3 → exactly 3 succeed, 7 INVITE_EXHAUSTED', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('race');
    const joiners = await Promise.all(
      Array.from({ length: 10 }, (_, i) => signupAsUser(env.baseUrl, `rc${i}`)),
    );
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 3 });
    const code = inv.body.invite.code;

    const results = await Promise.all(
      joiners.map((j) =>
        request(env.baseUrl)
          .post(`/invites/${code}/accept`)
          .set('origin', ORIGIN)
          .set('Authorization', `Bearer ${j.accessToken}`),
      ),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const exhausted = results.filter(
      (r) => r.status === 410 && r.body.errorCode === 'INVITE_EXHAUSTED',
    ).length;
    expect(ok).toBe(3);
    expect(exhausted).toBe(7);

    const invite = await env.prisma.invite.findUnique({ where: { code } });
    expect(invite?.usedCount).toBe(3);
  }, 60_000);
});
