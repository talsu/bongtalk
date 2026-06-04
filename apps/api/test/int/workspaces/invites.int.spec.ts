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

  // S66 fix-forward (FR-W21 / task-032): 취소된 초대의 preview 는 generic 404 가 아니라
  // 410 INVITE_REVOKED 를 반환해야 InviteAcceptPage 가 만료/취소 전용 화면으로 분기한다.
  it('returns 410 INVITE_REVOKED on a revoked invite', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('irv');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code;
    const inviteId = inv.body.invite.id;

    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/invites/${inviteId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const preview = await request(env.baseUrl).get(`/invites/${code}`);
    expect(preview.status).toBe(410);
    expect(preview.body.errorCode).toBe('INVITE_REVOKED');
  });

  // S67 (D13 / FR-W03): 이미 멤버인 사용자의 재수락은 throw(409) 대신 멱등 200 +
  // { workspace, alreadyMember:true } 를 반환한다(다시 눌러도 워크스페이스로 이동).
  it('returns 200 + alreadyMember=true when accepting a second time', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('iam');
    const joiner = await signupAsUser(env.baseUrl, 'iam2');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code;

    const first = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .expect(201);
    expect(first.body.alreadyMember).toBe(false);

    const again = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(again.status).toBe(200);
    expect(again.body.alreadyMember).toBe(true);
    expect(again.body.workspace.id).toBe(workspaceId);

    // 멱등 재수락은 좌석을 소모하지 않는다(usedCount 는 1 그대로).
    const invite = await env.prisma.invite.findUnique({ where: { code } });
    expect(invite?.usedCount).toBe(1);
  });
});

// S67 (D13 / FR-W02·W03·W17): MODERATOR 게이트 · 임시 멤버십 · 관리 목록 · hard delete.
describe('S67 invite management (FR-W02/W03/W17)', () => {
  // owner 가 joiner 를 가입시킨 뒤 지정 역할로 승격한다(MODERATOR/ADMIN 게이트 검증용).
  async function joinAndPromote(
    ownerToken: string,
    workspaceId: string,
    prefix: string,
    role: 'MODERATOR' | 'ADMIN' | 'MEMBER',
  ) {
    const user = await signupAsUser(env.baseUrl, prefix);
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ maxUses: 50 });
    await request(env.baseUrl)
      .post(`/invites/${inv.body.invite.code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(201);
    if (role !== 'MEMBER') {
      await request(env.baseUrl)
        .patch(`/workspaces/${workspaceId}/members/${user.userId}/role`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role })
        .expect(200);
    }
    return user;
  }

  it('FR-W02: MODERATOR can create an invite (200/201)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('mcr');
    const mod = await joinAndPromote(owner.accessToken, workspaceId, 'mcr-m', 'MODERATOR');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ maxUses: 3 });
    expect(res.status).toBe(201);
    expect(res.body.invite.code).toMatch(/^[A-Za-z2-9]{8}$/);
  });

  it('FR-W02: plain MEMBER cannot create an invite (403)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('mem');
    const member = await joinAndPromote(owner.accessToken, workspaceId, 'mem-m', 'MEMBER');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ maxUses: 3 });
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe('WORKSPACE_INSUFFICIENT_ROLE');
  });

  it('FR-W17: ADMIN lists ALL invites; MODERATOR lists only their own', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('lst');
    const mod = await joinAndPromote(owner.accessToken, workspaceId, 'lst-m', 'MODERATOR');
    // owner creates one, moderator creates one.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 })
      .expect(201);
    const modInv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({ maxUses: 5 })
      .expect(201);

    const ownerList = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/invites`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    // owner(ADMIN/OWNER) sees both; derived usesRemaining/active present.
    expect(ownerList.body.invites.length).toBeGreaterThanOrEqual(2);
    expect(ownerList.body.invites[0]).toHaveProperty('usesRemaining');
    expect(ownerList.body.invites[0]).toHaveProperty('active');

    const modList = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/invites`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .expect(200);
    expect(modList.body.invites.map((i: { id: string }) => i.id)).toEqual([modInv.body.invite.id]);
  });

  it('FR-W17: MODERATOR cannot revoke another creator’s invite (404 INVITE_NOT_FOUND)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('rvk');
    const mod = await joinAndPromote(owner.accessToken, workspaceId, 'rvk-m', 'MODERATOR');
    // owner-created invite — moderator may not revoke it.
    const ownerInv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 })
      .expect(201);
    const res = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/invites/${ownerInv.body.invite.id}`)
      .set('Authorization', `Bearer ${mod.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('INVITE_NOT_FOUND');
    // 여전히 활성 — 좌석/취소 영향 없음.
    const still = await env.prisma.invite.findUnique({ where: { id: ownerInv.body.invite.id } });
    expect(still?.revokedAt).toBeNull();
  });

  it('FR-W03: accepting a temporary invite records WorkspaceMember.isTemporary=true', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('tmp');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5, temporary: true })
      .expect(201);
    expect(inv.body.invite.temporary).toBe(true);

    const joiner = await signupAsUser(env.baseUrl, 'tmp-j');
    await request(env.baseUrl)
      .post(`/invites/${inv.body.invite.code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .expect(201);

    const member = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: joiner.userId } },
    });
    expect(member?.isTemporary).toBe(true);
  });

  it('FR-W17 (Fork C-2): hard-delete removes the row; subsequent accept → 404', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('hdl');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 })
      .expect(201);
    const code = inv.body.invite.code;

    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/invites/${inv.body.invite.id}/permanent`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    // 행이 제거됐으므로 preview/accept 는 NOT_FOUND(404). soft revoke 의 410 과 구분된다.
    const gone = await env.prisma.invite.findUnique({ where: { id: inv.body.invite.id } });
    expect(gone).toBeNull();

    // S67 fix-forward (security MEDIUM + reviewer #5): 파괴적 hard delete 는 INVITE_DELETED
    // outbox + AuditAction.INVITE_DELETED 를 같은 commit 으로 남긴다(rogue admin 추적).
    const outboxRow = await env.prisma.outboxEvent.findFirst({
      where: {
        aggregateType: 'invite',
        aggregateId: inv.body.invite.id,
        eventType: 'workspace.invite.deleted',
      },
    });
    expect(outboxRow).not.toBeNull();
    const auditRow = await env.prisma.auditLog.findFirst({
      where: { workspaceId, action: 'INVITE_DELETED', targetId: inv.body.invite.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorId).toBe(owner.userId);
    expect((auditRow?.details as { code?: string } | null)?.code).toBe(code);

    const joiner = await signupAsUser(env.baseUrl, 'hdl-j');
    const res = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('INVITE_NOT_FOUND');
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
