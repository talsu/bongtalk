/**
 * S63 (D12 / FR-RM05·06·07) 모더레이션 통합 테스트:
 *  - FR-RM05 Kick: KICK_MEMBERS 권한자 강제 퇴장 + 재가입 가능 + 5초 Undo(토큰 검증·
 *    재가입/만료 시 409) + AuditLog(MEMBER_KICK).
 *  - FR-RM06 Ban: BAN_MEMBERS 권한자 영구 차단(BannedMember) + 초대 재가입 거부 +
 *    unban + AuditLog(MEMBER_BAN/UNBAN).
 *  - FR-RM07 Timeout: TIMEOUT_MEMBERS 권한자 음소거(send/reaction 차단) + 만료 자동
 *    통과(lazy) + untimeout + AuditLog(MEMBER_TIMEOUT/UNTIMEOUT).
 *  - 권한 비트 게이트 + position 계층 방어(상위 역할/OWNER/자기 자신 거부).
 *
 * 단일 파일 실행(OOM 회피): pnpm --filter @qufox/api test -- s63-moderation
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
): Promise<{ userId: string; accessToken: string; code: string }> {
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
  return { userId: joiner.userId, accessToken: joiner.accessToken, code };
}

async function newInviteCode(workspaceId: string, ownerAccessToken: string): Promise<string> {
  const invite = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({})
    .expect(201);
  return invite.body.invite.code as string;
}

async function createChannel(
  workspaceId: string,
  ownerAccessToken: string,
  prefix: string,
): Promise<string> {
  const ch = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('Authorization', `Bearer ${ownerAccessToken}`)
    .send({ name: `${prefix}-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' })
    .expect(201);
  return ch.body.id as string;
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

function auditCount(workspaceId: string, action: string, targetId: string): Promise<number> {
  return env.prisma.auditLog.count({ where: { workspaceId, action, targetId } });
}

// ── FR-RM05 Kick + Undo ─────────────────────────────────────────────────────

describe('S63 FR-RM05: kick + 5초 undo', () => {
  it('OWNER kicks a member → removed + AuditLog + undo token returned; undo rejoins', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63kick');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63kickm');

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: '규칙 위반' })
      .expect(200);
    expect(typeof res.body.undoToken).toBe('string');
    expect(typeof res.body.undoExpiresAt).toBe('string');

    // 멤버 삭제 확인.
    const removed = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
    });
    expect(removed).toBeNull();
    // AuditLog(MEMBER_KICK) 기록.
    expect(await auditCount(workspaceId, 'MEMBER_KICK', member.userId)).toBe(1);
    // kicked 은 차단되지 않는다(재가입 가능).
    const banned = await env.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
    });
    expect(banned).toBeNull();

    // Undo → 재가입.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick-undo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ undoToken: res.body.undoToken as string })
      .expect(204);
    const rejoined = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
    });
    expect(rejoined).not.toBeNull();
    // 재가입은 MEMBER 시스템 MemberRole 을 동기한다(권한 동기 불변식).
    const memberRoles = await env.prisma.memberRole.count({
      where: { workspaceId, userId: member.userId },
    });
    expect(memberRoles).toBeGreaterThanOrEqual(1);
  });

  it('undo with an invalid/expired token → 409 KICK_UNDO_INVALID', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63kicktok');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63kicktokm');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({})
      .expect(200);
    const bad = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick-undo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ undoToken: '00000000-0000-0000-0000-000000000000' })
      .expect(409);
    expect(bad.body.errorCode).toBe('KICK_UNDO_INVALID');
  });

  it('undo TTL is 5 seconds in Redis', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63kickttl');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63kickttlm');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({})
      .expect(200);
    const ttl = await env.redis.ttl(`kick_undo:${workspaceId}:${owner.userId}:${member.userId}`);
    // EX 5 — Redis TTL 은 발급 직후 5(혹은 경합으로 4) 이내.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it('undo after target rejoined → 409 (token consumed / already member)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63kickre');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63kickrem');
    const kickRes = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({})
      .expect(200);
    // 대상이 새 초대로 스스로 재가입.
    const code = await newInviteCode(workspaceId, owner.accessToken);
    await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(201);
    // 이제 undo 는 P2002(이미 멤버) → 409.
    const undo = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/kick-undo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ undoToken: kickRes.body.undoToken as string })
      .expect(409);
    expect(undo.body.errorCode).toBe('KICK_UNDO_INVALID');
  });
});

// ── FR-RM06 Ban ──────────────────────────────────────────────────────────────

describe('S63 FR-RM06: ban / unban / re-join block', () => {
  it('OWNER bans a member → removed + BannedMember + AuditLog; invite re-accept blocked', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63ban');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63banm');

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/bans`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId, reason: '스팸' })
      .expect(204);

    const removed = await env.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
    });
    expect(removed).toBeNull();
    const banned = await env.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
    });
    expect(banned).not.toBeNull();
    expect(banned?.reason).toBe('스팸');
    expect(await auditCount(workspaceId, 'MEMBER_BAN', member.userId)).toBe(1);

    // 새 초대로도 재가입 불가(차단 누출 방지 위해 중립 404 INVITE_NOT_FOUND).
    const code = await newInviteCode(workspaceId, owner.accessToken);
    const reaccept = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(404);
    expect(reaccept.body.errorCode).toBe('INVITE_NOT_FOUND');
  });

  it('listBans returns the banned user; unban removes it (404 when not banned)', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63banlist');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63banlistm');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/bans`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId })
      .expect(204);

    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/moderation/bans`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body.bans.some((b: { userId: string }) => b.userId === member.userId)).toBe(true);

    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/moderation/bans/${member.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);
    expect(await auditCount(workspaceId, 'MEMBER_UNBAN', member.userId)).toBe(1);

    // 두 번째 unban → 404 MEMBER_NOT_BANNED.
    const second = await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/moderation/bans/${member.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
    expect(second.body.errorCode).toBe('MEMBER_NOT_BANNED');
  });

  it('double ban → 409 MEMBER_ALREADY_BANNED', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63bandup');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63bandupm');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/bans`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId })
      .expect(204);
    const dup = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/bans`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId })
      .expect(409);
    expect(dup.body.errorCode).toBe('MEMBER_ALREADY_BANNED');
  });
});

// ── FR-RM07 Timeout ──────────────────────────────────────────────────────────

describe('S63 FR-RM07: timeout blocks send/reaction, lazy expiry passes', () => {
  it('timed-out member cannot send; untimeout restores; AuditLog recorded', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63to');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63tom');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's63toch');

    // 음소거 전: 전송 성공.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ content: 'before timeout' })
      .expect(201);

    // 1시간 음소거.
    const to = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/timeout`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ durationSeconds: 3600, reason: '도배' })
      .expect(200);
    expect(to.body.userId).toBe(member.userId);
    expect(typeof to.body.mutedUntil).toBe('string');
    expect(await auditCount(workspaceId, 'MEMBER_TIMEOUT', member.userId)).toBe(1);

    // 음소거 중: 전송 차단(403 MEMBER_TIMED_OUT).
    const blocked = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ content: 'while muted' })
      .expect(403);
    expect(blocked.body.errorCode).toBe('MEMBER_TIMED_OUT');

    // 반응도 차단.
    const msgId = (
      await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ content: 'owner msg' })
        .expect(201)
    ).body.message.id as string;
    const reactBlocked = await request(env.baseUrl)
      .post(`/messages/${msgId}/reactions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ emoji: '👍' })
      .expect(403);
    expect(reactBlocked.body.errorCode).toBe('MEMBER_TIMED_OUT');

    // VIEW/READ 는 유지 — 메시지 목록 조회는 가능.
    await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    // untimeout → 다시 전송 가능.
    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/moderation/members/${member.userId}/timeout`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);
    expect(await auditCount(workspaceId, 'MEMBER_UNTIMEOUT', member.userId)).toBe(1);
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ content: 'after untimeout' })
      .expect(201);
  });

  it('expired timeout auto-passes (lazy) — past mutedUntil does not block', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63toexp');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63toexpm');
    const channelId = await createChannel(workspaceId, owner.accessToken, 's63toexpch');

    // mutedUntil 을 과거로 직접 설정(만료 상태 시뮬레이션 — lazy 게이트는 now 와 비교).
    await env.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: member.userId } },
      data: { mutedUntil: new Date('2024-12-31T23:00:00Z') },
    });
    // 만료분이므로 전송이 통과해야 한다.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ content: 'expired timeout passes' })
      .expect(201);
    // 멤버 목록 mutedUntil 은 만료분이라 null 로 마스킹된다.
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members?include_offline=true`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const allMembers = [
      ...list.body.hoist.flatMap((g: { members: unknown[] }) => g.members),
      ...list.body.groups.flatMap((g: { members: unknown[] }) => g.members),
    ] as Array<{ userId: string; mutedUntil: string | null }>;
    const row = allMembers.find((m) => m.userId === member.userId);
    expect(row?.mutedUntil ?? null).toBeNull();
  });

  it('active timeout surfaces mutedUntil in member list', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63tobadge');
    const member = await inviteAndJoin(workspaceId, owner.accessToken, 's63tobadgem');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${member.userId}/timeout`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ durationSeconds: 3600 })
      .expect(200);
    const list = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members?include_offline=true`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const allMembers = [
      ...list.body.hoist.flatMap((g: { members: unknown[] }) => g.members),
      ...list.body.groups.flatMap((g: { members: unknown[] }) => g.members),
    ] as Array<{ userId: string; mutedUntil: string | null }>;
    const row = allMembers.find((m) => m.userId === member.userId);
    expect(row?.mutedUntil).toBeTruthy();
  });
});

// ── 권한 비트 + position 계층 방어 ─────────────────────────────────────────────

describe('S63: permission-bit gate + position hierarchy defense', () => {
  it('plain MEMBER cannot kick (no KICK_MEMBERS bit) → 403', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63perm');
    const actor = await inviteAndJoin(workspaceId, owner.accessToken, 's63perma');
    const target = await inviteAndJoin(workspaceId, owner.accessToken, 's63permt');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${target.userId}/kick`)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({})
      .expect(403);
    expect(res.body.errorCode).toBe('WORKSPACE_INSUFFICIENT_ROLE');
  });

  it('MODERATOR has the bit and can kick a MEMBER', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63mod');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's63moda');
    const target = await inviteAndJoin(workspaceId, owner.accessToken, 's63modt');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${target.userId}/kick`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({})
      .expect(200);
  });

  it('MODERATOR cannot kick an ADMIN (target outranks) → 403 MODERATION_TARGET_HIGHER', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63rank');
    const mod = await inviteAndJoin(workspaceId, owner.accessToken, 's63ranka');
    const admin = await inviteAndJoin(workspaceId, owner.accessToken, 's63rankt');
    await setRole(workspaceId, owner.accessToken, mod.userId, 'MODERATOR');
    await setRole(workspaceId, owner.accessToken, admin.userId, 'ADMIN');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${admin.userId}/kick`)
      .set('Authorization', `Bearer ${mod.accessToken}`)
      .send({})
      .expect(403);
    expect(res.body.errorCode).toBe('MODERATION_TARGET_HIGHER');
  });

  it('cannot moderate the OWNER → 403 MODERATION_TARGET_HIGHER', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63own');
    const admin = await inviteAndJoin(workspaceId, owner.accessToken, 's63owna');
    await setRole(workspaceId, owner.accessToken, admin.userId, 'ADMIN');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${owner.userId}/kick`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({})
      .expect(403);
    expect(res.body.errorCode).toBe('MODERATION_TARGET_HIGHER');
  });

  it('cannot moderate yourself → 400 MODERATION_CANNOT_SELF', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s63self');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/moderation/members/${owner.userId}/kick`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({})
      .expect(400);
    expect(res.body.errorCode).toBe('MODERATION_CANNOT_SELF');
  });
});
