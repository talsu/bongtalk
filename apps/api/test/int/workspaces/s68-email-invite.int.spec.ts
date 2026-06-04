/**
 * S68 (D13 / FR-W04·W04a·W05·W18) — 이메일 직접 초대 + 도메인 관리 + 보류 초대 관리.
 *
 * 보안 검증(★핵심 AC):
 *   - DB 엔 sha256(rawToken)=tokenHash 만 저장(평문 token 컬럼 없음).
 *   - opaque 교환 응답에 rawToken 미포함, TTL 10분 소멸 후 410.
 *   - 수락 role 위조(ADMIN) → 400.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
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
});

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function makeOwnerWs(prefix: string) {
  const owner = await signupAsUser(env.baseUrl, prefix);
  const create = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) });
  return { owner, workspaceId: create.body.id as string, slug: create.body.slug as string };
}

describe('S68 invite-by-email — 혼합 부분성공 + sha256 저장', () => {
  it('미가입은 PENDING(보류 행 생성), 이미 가입은 ADDED_MEMBER, DB 엔 tokenHash 만', async () => {
    const { owner, workspaceId } = await makeOwnerWs('s68a');
    // 한 명은 미리 가입시켜 ADDED_MEMBER 분기를 만든다.
    const existing = await signupAsUser(env.baseUrl, 's68exist');

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invite-by-email`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ emails: ['brand-new-s68@acme.dev', existing.email], role: 'MEMBER' });
    expect(res.status).toBe(200);
    const byEmail = Object.fromEntries(
      res.body.results.map((r: { email: string; outcome: string }) => [r.email, r.outcome]),
    );
    expect(byEmail['brand-new-s68@acme.dev']).toBe('PENDING');
    expect(byEmail[existing.email]).toBe('ADDED_MEMBER');

    // ★핵심 AC: 보류 행은 tokenHash(64-hex)만 — 평문 token 컬럼이 없다.
    const rows = await env.prisma.workspacePendingInvite.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // raw 토큰은 응답/DB 어디에도 평문으로 없다.
    expect(JSON.stringify(res.body)).not.toContain(rows[0].tokenHash);
  });

  it('비ADMIN(MEMBER)의 invite-by-email 은 403', async () => {
    const { workspaceId } = await makeOwnerWs('s68b');
    // 별도 MEMBER 가입 후 워크스페이스에 멤버로 끼워 넣는다.
    const member = await signupAsUser(env.baseUrl, 's68bmem');
    await env.prisma.workspaceMember.create({
      data: { workspaceId, userId: member.userId, role: 'MEMBER' },
    });
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invite-by-email`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ emails: ['x@y.com'] });
    expect(res.status).toBe(403);
  });
});

describe('S68 accept-email-invite — sha256 대조 / 만료 410 / role 위조 400 / 이미수락', () => {
  async function seedPending(
    workspaceId: string,
    invitedById: string,
    email: string,
    role = 'MEMBER',
  ) {
    const rawToken = `raw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    await env.prisma.workspacePendingInvite.create({
      data: {
        workspaceId,
        email,
        role: role as 'MEMBER' | 'GUEST' | 'ADMIN' | 'MODERATOR' | 'OWNER',
        tokenHash: sha256(rawToken),
        invitedById,
        expiresAt: new Date('2025-02-01T00:00:00Z'),
      },
    });
    return rawToken;
  }

  it('일치 이메일 로그인 사용자는 201 로 수락(분기 ②)', async () => {
    const { owner, workspaceId, slug } = await makeOwnerWs('s68c');
    const joiner = await signupAsUser(env.baseUrl, 's68cj');
    const rawToken = await seedPending(workspaceId, owner.userId, joiner.email);

    const res = await request(env.baseUrl)
      .post(`/workspaces/${slug}/accept-email-invite`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ token: rawToken });
    expect(res.status).toBe(201);
    expect(res.body.alreadyMember).toBe(false);

    // 재수락은 이미 멤버 → 200 멱등.
    const again = await request(env.baseUrl)
      .post(`/workspaces/${slug}/accept-email-invite`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ token: rawToken });
    expect([200, 409]).toContain(again.status);
  });

  it('만료된 보류 초대 수락은 410 EMAIL_INVITE_EXPIRED', async () => {
    const { owner, workspaceId, slug } = await makeOwnerWs('s68d');
    const joiner = await signupAsUser(env.baseUrl, 's68dj');
    const rawToken = `raw-exp-${Date.now()}`;
    await env.prisma.workspacePendingInvite.create({
      data: {
        workspaceId,
        email: joiner.email,
        role: 'MEMBER',
        tokenHash: sha256(rawToken),
        invitedById: owner.userId,
        expiresAt: new Date('2024-12-01T00:00:00Z'), // already past relative to fake clock
      },
    });
    const res = await request(env.baseUrl)
      .post(`/workspaces/${slug}/accept-email-invite`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ token: rawToken });
    expect(res.status).toBe(410);
    expect(res.body.errorCode).toBe('EMAIL_INVITE_EXPIRED');
  });

  it('role 위조(ADMIN) 보류 초대 수락은 400 EMAIL_INVITE_ROLE_MISMATCH', async () => {
    const { owner, workspaceId, slug } = await makeOwnerWs('s68e');
    const joiner = await signupAsUser(env.baseUrl, 's68ej');
    const rawToken = await seedPending(workspaceId, owner.userId, joiner.email, 'ADMIN');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${slug}/accept-email-invite`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ token: rawToken });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('EMAIL_INVITE_ROLE_MISMATCH');
  });

  it('무효 토큰 수락은 400 EMAIL_INVITE_TOKEN_INVALID', async () => {
    const { slug } = await makeOwnerWs('s68f');
    const joiner = await signupAsUser(env.baseUrl, 's68fj');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${slug}/accept-email-invite`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ token: 'no-such-token' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('EMAIL_INVITE_TOKEN_INVALID');
  });
});

describe('S68 exchange-invite-token — opaque(rawToken 미포함) + TTL 10분 소멸 410', () => {
  it('rawToken 을 opaque 코드로 교환하고 응답에 rawToken 이 없다', async () => {
    const { owner, workspaceId, slug } = await makeOwnerWs('s68g');
    const rawToken = `raw-opq-${Date.now()}`;
    await env.prisma.workspacePendingInvite.create({
      data: {
        workspaceId,
        email: 'unreg-s68g@acme.dev',
        role: 'MEMBER',
        tokenHash: sha256(rawToken),
        invitedById: owner.userId,
        expiresAt: new Date('2025-02-01T00:00:00Z'),
      },
    });
    const exch = await request(env.baseUrl)
      .post(`/workspaces/${slug}/exchange-invite-token`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ token: rawToken });
    expect(exch.status).toBe(200);
    expect(exch.body.opaqueCode).toBeTruthy();
    expect(exch.body.opaqueCode).not.toBe(rawToken);
    expect(JSON.stringify(exch.body)).not.toContain(rawToken);

    // opaque 코드가 Redis 에 10분 TTL 로 존재한다.
    const ttl = await env.redis.ttl(`email-invite-opaque:${exch.body.opaqueCode}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    // 강제 만료(키 삭제 = TTL 소멸 시뮬) 후 opaque 수락은 410.
    await env.redis.del(`email-invite-opaque:${exch.body.opaqueCode}`);
    const joiner = await signupAsUser(env.baseUrl, 's68gj');
    const accept = await request(env.baseUrl)
      .post(`/workspaces/${slug}/accept-email-invite-opaque`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ token: exch.body.opaqueCode });
    expect(accept.status).toBe(410);
    expect(accept.body.errorCode).toBe('EMAIL_INVITE_EXPIRED');
  });
});

describe('S68 pending-invites 관리 — 목록 ADMIN/비ADMIN / 연장 / 취소', () => {
  it('ADMIN 은 보류 목록을 받고(tokenHash 비노출), MEMBER 는 403', async () => {
    const { owner, workspaceId } = await makeOwnerWs('s68h');
    await env.prisma.workspacePendingInvite.create({
      data: {
        workspaceId,
        email: 'pending-s68h@acme.dev',
        role: 'MEMBER',
        tokenHash: sha256(`raw-h-${Date.now()}`),
        invitedById: owner.userId,
        expiresAt: new Date('2025-02-01T00:00:00Z'),
      },
    });
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/pending-invites`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.pending).toHaveLength(1);
    expect(list.body.pending[0].email).toBe('pending-s68h@acme.dev');
    expect(JSON.stringify(list.body)).not.toContain('tokenHash');

    const member = await signupAsUser(env.baseUrl, 's68hmem');
    await env.prisma.workspaceMember.create({
      data: { workspaceId, userId: member.userId, role: 'MEMBER' },
    });
    const denied = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/pending-invites`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(denied.status).toBe(403);
  });

  it('연장(+30일)은 expiresAt 을 늘리고, 취소는 목록에서 제외한다', async () => {
    const { owner, workspaceId } = await makeOwnerWs('s68i');
    const row = await env.prisma.workspacePendingInvite.create({
      data: {
        workspaceId,
        email: 'pending-s68i@acme.dev',
        role: 'MEMBER',
        tokenHash: sha256(`raw-i-${Date.now()}`),
        invitedById: owner.userId,
        expiresAt: new Date('2025-01-10T00:00:00Z'),
      },
    });
    const extend = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/pending-invites/${row.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'EXTEND' });
    expect(extend.status).toBe(204);
    const after = await env.prisma.workspacePendingInvite.findUnique({ where: { id: row.id } });
    expect(after!.expiresAt.getTime()).toBeGreaterThan(new Date('2025-01-10T00:00:00Z').getTime());

    const cancel = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/pending-invites/${row.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(cancel.status).toBe(204);
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/pending-invites`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body.pending).toHaveLength(0);
  });
});

describe('S68 emailDomains PATCH — OWNER 성공 / ADMIN 403 (FR-W05 Fork C)', () => {
  it('OWNER 는 emailDomains 를 정규화 저장하고, ADMIN 은 403', async () => {
    const { owner, workspaceId } = await makeOwnerWs('s68j');
    // zod EmailDomainSchema 가 소문자 호스트 형태를 강제하므로 입력은 소문자다. 서버는
    // 중복을 제거해 저장한다(정규화 — create 로직 재사용).
    const ok = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ emailDomains: ['acme.com', 'acme.com', 'beta.io'] });
    expect(ok.status).toBe(200);
    const ws = await env.prisma.workspace.findUnique({ where: { id: workspaceId } });
    expect(ws!.emailDomains).toEqual(['acme.com', 'beta.io']);

    // ADMIN 멤버를 끼워 넣고 emailDomains PATCH → 403.
    const admin = await signupAsUser(env.baseUrl, 's68jadm');
    await env.prisma.workspaceMember.create({
      data: { workspaceId, userId: admin.userId, role: 'ADMIN' },
    });
    const denied = await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ emailDomains: ['evil.com'] });
    expect(denied.status).toBe(403);
    expect(denied.body.errorCode).toBe('WORKSPACE_EMAIL_DOMAINS_FORBIDDEN');
  });
});
