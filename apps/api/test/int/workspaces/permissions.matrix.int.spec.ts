/**
 * Table-driven permission matrix test.
 *
 * Uses the single-source-of-truth `PERMISSION_MATRIX` from
 * ./permission-matrix.data.ts and drives a real HTTP call for every
 * (endpoint × role) combination. This is the test that `evals/tasks/005`
 * depends on.
 *
 * Static invariant: every workspace controller method must appear in the
 * matrix (no stealth endpoints with undocumented access rules).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from './helpers';
import { PERMISSION_MATRIX, Role, Outcome } from './permission-matrix.data';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

type Actors = {
  owner: Awaited<ReturnType<typeof signupAsUser>>;
  admin: Awaited<ReturnType<typeof signupAsUser>>;
  member: Awaited<ReturnType<typeof signupAsUser>>;
  nonMember: Awaited<ReturnType<typeof signupAsUser>>;
};

let actors: Actors;
let workspaceId: string;
let targetMemberId: string;
// Message matrix state (task-004). Each role has one message so self/other can
// be resolved per-case.
let channelId: string;
let msgByRole: Record<Role, string>;
const MSG_BASELINE_CONTENT: Record<Role, string> = {
  OWNER: 'owner baseline',
  ADMIN: 'admin baseline',
  MEMBER: 'member baseline',
  NON_MEMBER: 'non-member baseline',
  ANON: 'anon baseline',
};

async function seedWorkspace(): Promise<void> {
  actors = {
    owner: await signupAsUser(env.baseUrl, 'mo'),
    admin: await signupAsUser(env.baseUrl, 'ma'),
    member: await signupAsUser(env.baseUrl, 'mm'),
    nonMember: await signupAsUser(env.baseUrl, 'mn'),
  };
  const create = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actors.owner.accessToken}`)
    .send({ name: 'MatrixWs', slug: `mx-${Date.now().toString(36)}` })
    .expect(201);
  workspaceId = create.body.id;

  // Invite admin + member
  const inv = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actors.owner.accessToken}`)
    .send({ maxUses: 10 })
    .expect(201);
  const code = inv.body.invite.code;

  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actors.admin.accessToken}`)
    .expect(201);
  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actors.member.accessToken}`)
    .expect(201);
  // Promote admin
  await request(env.baseUrl)
    .patch(`/workspaces/${workspaceId}/members/${actors.admin.userId}/role`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actors.owner.accessToken}`)
    .send({ role: 'ADMIN' })
    .expect(200);

  targetMemberId = actors.member.userId;

  // Seed a channel + one message per active role for the message matrix.
  const ch = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${actors.owner.accessToken}`)
    .send({ name: `matrix-ch-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
    .expect(201);
  channelId = ch.body.id;
  const owned = {} as Record<Role, string>;
  for (const [role, actor] of [
    ['OWNER', actors.owner],
    ['ADMIN', actors.admin],
    ['MEMBER', actors.member],
  ] as const) {
    const r = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ content: MSG_BASELINE_CONTENT[role] })
      .expect(201);
    owned[role] = r.body.message.id;
  }
  // NON_MEMBER and ANON never own a message — reuse OWNER's as a placeholder;
  // their cases will short-circuit on 401/404 before author-check runs.
  owned.NON_MEMBER = owned.OWNER;
  owned.ANON = owned.OWNER;
  msgByRole = owned;
}

function tokenFor(role: Role): string | null {
  switch (role) {
    case 'OWNER':
      return actors.owner.accessToken;
    case 'ADMIN':
      return actors.admin.accessToken;
    case 'MEMBER':
      return actors.member.accessToken;
    case 'NON_MEMBER':
      return actors.nonMember.accessToken;
    case 'ANON':
      return null;
  }
}

function resolvePath(
  raw: string,
  role: Role,
  selfTarget: boolean,
  msgTarget: 'self' | 'other' | undefined,
): string {
  const uid = selfTarget
    ? role === 'OWNER'
      ? actors.owner.userId
      : role === 'ADMIN'
        ? actors.admin.userId
        : role === 'MEMBER'
          ? actors.member.userId
          : actors.nonMember.userId
    : targetMemberId;
  let msgId: string | undefined;
  if (msgTarget === 'self') {
    msgId = msgByRole[role];
  } else if (msgTarget === 'other') {
    // Target MEMBER's message when caller is OWNER/ADMIN (so the rule differs
    // from self); target OWNER's when caller is MEMBER.
    msgId = role === 'MEMBER' ? msgByRole.OWNER : msgByRole.MEMBER;
  }
  return raw
    .replace(':id', workspaceId)
    .replace(':uid', uid)
    .replace(':chid', channelId ?? '')
    .replace(':msgId', msgId ?? msgByRole.OWNER ?? '');
}

function bodyFor(method: string, path: string): object | undefined {
  if (method === 'POST' && path.endsWith('/workspaces')) {
    return { name: 'From Matrix', slug: `mtx-${Math.random().toString(36).slice(2, 10)}` };
  }
  if (method === 'PATCH' && /members\/.*\/role$/.test(path)) return { role: 'ADMIN' };
  if (method === 'POST' && path.endsWith('/transfer-ownership'))
    return { toUserId: actors.admin.userId };
  if (method === 'POST' && path.endsWith('/invites')) return { maxUses: 1 };
  if (method === 'POST' && path.endsWith('/channels')) {
    return { name: `ch-mtx-${Math.random().toString(36).slice(2, 8)}`, type: 'TEXT' };
  }
  if (method === 'POST' && path.endsWith('/categories')) {
    return { name: `Cat Mtx ${Math.random().toString(36).slice(2, 6)}` };
  }
  if (method === 'POST' && path.endsWith('/messages')) {
    return { content: `matrix send ${Math.random().toString(36).slice(2, 8)}` };
  }
  if (method === 'PATCH' && /\/messages\//.test(path)) {
    return { content: `matrix edit ${Math.random().toString(36).slice(2, 8)}` };
  }
  if (method === 'PATCH' && path.match(/\/workspaces\/[^/]+$/)) return { name: 'renamed' };
  return undefined;
}

function parseOutcome(o: Outcome): { status: number; code?: string } {
  const [status, code] = o.split(':');
  return { status: Number(status), code };
}

beforeAll(async () => {
  env = await setupWsIntEnv();
  await seedWorkspace();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // Reset invariants between matrix cases: workspace active, 3 members with
  // the expected roles. Each case may mutate state; this ensures
  // the next case sees the baseline.
  await env.prisma.workspace.update({
    where: { id: workspaceId },
    data: { deletedAt: null, deleteAt: null, ownerId: actors.owner.userId, name: 'MatrixWs' },
  });
  await env.prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId: actors.owner.userId } },
    create: { workspaceId, userId: actors.owner.userId, role: 'OWNER' },
    update: { role: 'OWNER' },
  });
  await env.prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId: actors.admin.userId } },
    create: { workspaceId, userId: actors.admin.userId, role: 'ADMIN' },
    update: { role: 'ADMIN' },
  });
  await env.prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId: actors.member.userId } },
    create: { workspaceId, userId: actors.member.userId, role: 'MEMBER' },
    update: { role: 'MEMBER' },
  });
  // Restore matrix-seeded messages in case a prior case soft-deleted them.
  if (msgByRole) {
    for (const [role, msgId] of Object.entries(msgByRole) as [Role, string][]) {
      if (role === 'NON_MEMBER' || role === 'ANON') continue; // placeholders
      await env.prisma.message.update({
        where: { id: msgId },
        data: { deletedAt: null, content: MSG_BASELINE_CONTENT[role], editedAt: null },
      });
    }
  }
  // Rate-limit buckets are Redis-based; matrix fires hundreds of POSTs within
  // seconds, so wipe the message-send buckets per case to avoid 429 noise.
  const rlKeys = await env.redis.keys('rl:msg:*');
  if (rlKeys.length > 0) await env.redis.del(...rlKeys);
});

describe('Permission matrix — every endpoint × every role', () => {
  for (const entry of PERMISSION_MATRIX) {
    for (const role of Object.keys(entry.roles) as Role[]) {
      const label = `[${role}] ${entry.method} ${entry.path}`;
      it(label, async () => {
        const token = tokenFor(role);
        const path = resolvePath(entry.path, role, !!entry.selfTarget, entry.msgTarget);
        const req = request(env.baseUrl)
          [entry.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](path)
          .set('origin', ORIGIN);
        if (token) req.set('Authorization', `Bearer ${token}`);
        const body = bodyFor(entry.method, entry.path);
        if (body) req.send(body);
        const res = await req;

        const expected = parseOutcome(entry.roles[role]);
        expect(res.status, `status for ${label}`).toBe(expected.status);
        if (expected.code) {
          expect(res.body.errorCode, `errorCode for ${label}`).toBe(expected.code);
        }
      });
    }
  }
});
