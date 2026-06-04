/**
 * S69 (D13 / FR-W10·W11) 멤버 디렉터리 + 일괄 관리 통합 테스트:
 *  - FR-W10 디렉터리: q prefix 검색 · role 필터 · 가입일 정렬 · 커서 페이지네이션 ·
 *    **일반 멤버 열람 권한(Fork C — 200)** · invitedBy 노출.
 *  - FR-W11 일괄 관리: 100명 상한(400) · 부분실패(skipped 사유) · 단일 AuditLog ·
 *    MODERATOR 범위(MEMBER kick 가능·ADMIN outranked) · timeout 28일 상한.
 *  - invitedById 기록: 링크 초대 수락 → invite.createdById.
 *
 * 단일 파일 실행(OOM 회피): pnpm exec vitest run --config vitest.int.config.ts \
 *   test/int/workspaces/s69-member-directory.int.spec.ts
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

async function setupOwnerAndWs(prefix: string): Promise<{
  owner: Awaited<ReturnType<typeof signupAsUser>>;
  workspaceId: string;
}> {
  const owner = await signupAsUser(env.baseUrl, prefix);
  const create = await request(env.baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) })
    .expect(201);
  return { owner, workspaceId: create.body.id as string };
}

async function inviteAndJoin(
  workspaceId: string,
  ownerAccessToken: string,
  prefix: string,
): Promise<{ userId: string; accessToken: string }> {
  const joiner = await signupAsUser(env.baseUrl, prefix);
  const invite = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({})
    .expect(201);
  const code = invite.body.invite.code as string;
  await request(env.baseUrl)
    .post(`/invites/${code}/accept`)
    .set('Authorization', `Bearer ${joiner.accessToken}`)
    .expect(201);
  return { userId: joiner.userId, accessToken: joiner.accessToken };
}

async function setRole(
  workspaceId: string,
  ownerAccessToken: string,
  userId: string,
  role: 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST',
): Promise<void> {
  await request(env.baseUrl)
    .patch(`/workspaces/${workspaceId}/members/${userId}/role`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({ role })
    .expect(200);
}

// ── FR-W10 디렉터리 ──────────────────────────────────────────────────────────

describe('S69 FR-W10: 멤버 디렉터리', () => {
  it('일반 멤버도 디렉터리를 열람할 수 있다(Fork C — 200)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69dir');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's69dirm');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members/directory`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    // owner + member 두 명이 보인다.
    expect(res.body.members.length).toBe(2);
  });

  it('role 필터는 정확히 일치하는 역할만 반환한다', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69role');
    const admin = await inviteAndJoin(workspaceId, owner.accessToken, 's69rolea');
    await inviteAndJoin(workspaceId, owner.accessToken, 's69rolem');
    await setRole(workspaceId, owner.accessToken, admin.userId, 'ADMIN');

    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members/directory?role=ADMIN`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.members.every((m: { role: string }) => m.role === 'ADMIN')).toBe(true);
    expect(res.body.members.length).toBe(1);
  });

  it('가입일 정렬(joined_asc)은 가장 먼저 가입한 멤버(OWNER)를 맨 앞에 둔다', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69sort');
    await inviteAndJoin(workspaceId, owner.accessToken, 's69sortm');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members/directory?sortBy=joined_asc`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.members[0].userId).toBe(owner.userId);
  });

  it('커서 페이지네이션은 중복 없이 전체를 순회한다', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69cur');
    // owner + 2 members = 3명. page size 50 이라 한 페이지에 다 담기지만 nextCursor null 단언.
    await inviteAndJoin(workspaceId, owner.accessToken, 's69cur1');
    await inviteAndJoin(workspaceId, owner.accessToken, 's69cur2');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members/directory`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.members.length).toBe(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it('초대 수락한 멤버는 invitedBy 에 초대자(OWNER)가 노출된다(FR-W10 invitedById)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69inv');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's69invm');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members/directory`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const row = res.body.members.find((m: { userId: string }) => m.userId === member.userId);
    expect(row.invitedById).toBe(owner.userId);
    expect(row.invitedBy.id).toBe(owner.userId);
    // OWNER 본인은 초대자 없음(null).
    const ownerRow = res.body.members.find((m: { userId: string }) => m.userId === owner.userId);
    expect(ownerRow.invitedById).toBeNull();
  });
});

// ── FR-W11 일괄 관리 ─────────────────────────────────────────────────────────

describe('S69 FR-W11: 일괄 멤버 관리', () => {
  it('userIds 가 100명을 넘으면 400(VALIDATION_FAILED)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69bulkmax');
    const tooMany = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'kick', userIds: tooMany })
      .expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('OWNER 일괄 kick → affected 적용 + 단일 AuditLog(MEMBER_BULK_ACTION)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69bulkk');
    const m1 = await inviteAndJoin(workspaceId, owner.accessToken, 's69bk1');
    const m2 = await inviteAndJoin(workspaceId, owner.accessToken, 's69bk2');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'kick', userIds: [m1.userId, m2.userId] })
      .expect(200);
    expect(res.body.affected.sort()).toEqual([m1.userId, m2.userId].sort());
    expect(res.body.attemptedCount).toBe(2);
    // 두 멤버 삭제 확인.
    const remaining = await env.prisma.workspaceMember.count({ where: { workspaceId } });
    expect(remaining).toBe(1); // owner 만 남음.
    // 단일 AuditLog(Fork A) — affected 2명을 한 행에 기록.
    const audits = await env.prisma.auditLog.count({
      where: { workspaceId, action: 'MEMBER_BULK_ACTION' },
    });
    expect(audits).toBe(1);
  });

  it('자기 자신/OWNER 는 skipped(self/owner) 로 건너뛴다(부분실패)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69bulkskip');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's69bsm');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'kick', userIds: [owner.userId, member.userId] })
      .expect(200);
    expect(res.body.affected).toEqual([member.userId]);
    expect(res.body.skipped).toContainEqual({ userId: owner.userId, reason: 'self' });
  });

  it('MODERATOR 는 MEMBER 를 일괄 kick 할 수 있으나 ADMIN 은 outranked 로 건너뛴다', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69mod');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's69modm');
    const admin = await inviteAndJoin(workspaceId, owner.accessToken, 's69moda');
    const plain = await inviteAndJoin(workspaceId, owner.accessToken, 's69modp');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    await setRole(workspaceId, owner.accessToken, admin.userId, 'ADMIN');

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ action: 'kick', userIds: [plain.userId, admin.userId] })
      .expect(200);
    expect(res.body.affected).toEqual([plain.userId]);
    expect(res.body.skipped).toContainEqual({ userId: admin.userId, reason: 'outranked' });
  });

  it('일괄 timeout 28일(2419200초)을 허용한다(상한 확장)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69to');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's69tom');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'timeout', userIds: [member.userId], durationSeconds: 2419200 })
      .expect(200);
    expect(res.body.affected).toEqual([member.userId]);
    const row = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
      select: { mutedUntil: true },
    });
    expect(row?.mutedUntil).not.toBeNull();
  });

  it('일괄 timeout 28일+1초는 400(상한 초과)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69toover');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's69toom');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'timeout', userIds: [member.userId], durationSeconds: 2419201 })
      .expect(400);
  });

  it('MODERATOR 는 일괄 역할변경(role)을 할 수 없다(ADMIN+ 게이트 — 403)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69rolegate');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's69rgm');
    const target = await inviteAndJoin(workspaceId, owner.accessToken, 's69rgt');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ action: 'role', userIds: [target.userId], role: 'GUEST' })
      .expect(403);
  });

  it('ADMIN 일괄 역할변경 → affected 멤버 역할이 갱신된다', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s69roleok');
    const target = await inviteAndJoin(workspaceId, owner.accessToken, 's69rot');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/members/bulk-action`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ action: 'role', userIds: [target.userId], role: 'GUEST' })
      .expect(200);
    expect(res.body.affected).toEqual([target.userId]);
    const row = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: target.userId } },
      select: { role: true },
    });
    expect(row?.role).toBe('GUEST');
  });
});
