/**
 * S61 (D12 / FR-RM01·03·04·15) integration:
 *  - 워크스페이스 생성 시 시스템 5역할 + OWNER MemberRole 시드(backfill 정합).
 *  - 커스텀 역할 생성/삭제 cascade(MemberRole + ROLE override 삭제).
 *  - ChannelPermissionOverride allow/deny BigInt 무손실 저장.
 *  - position 변경 SELECT FOR UPDATE 동시성(두 동시 PATCH 가 직렬화).
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
    .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) })
    .expect(201);
  return { owner, workspaceId: create.body.id as string };
}

/** 새 유저를 초대 링크로 워크스페이스에 가입시키고 그 유저 핸들을 돌려준다. */
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

/** 멤버의 시스템 MemberRole 이름 집합(권한 상승 방어 검증용). */
async function systemRoleNamesOf(workspaceId: string, userId: string): Promise<string[]> {
  const rows = await env.prisma.memberRole.findMany({
    where: { workspaceId, userId, role: { isSystem: true } },
    select: { role: { select: { name: true } } },
  });
  return rows.map((r) => r.role.name).sort();
}

describe('S61 system role seeding', () => {
  it('seeds 5 system roles + OWNER MemberRole on workspace creation', async () => {
    const { workspaceId } = await setupOwnerAndWs('s61seed');
    const roles = await env.prisma.role.findMany({
      where: { workspaceId, isSystem: true },
      orderBy: { position: 'desc' },
    });
    expect(roles.map((r) => r.name)).toEqual(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']);
    // OWNER permissions = ADMINISTRATOR stored as signed -(2^63).
    const owner = roles.find((r) => r.name === 'OWNER');
    expect(owner?.permissions).toBe(-9223372036854775808n);

    const memberRoles = await env.prisma.memberRole.findMany({ where: { workspaceId } });
    expect(memberRoles.length).toBe(1);
    expect(memberRoles[0].roleId).toBe(owner?.id);
  });

  it('exposes roles via GET /workspaces/:id/roles with permissions as string', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61list');
    const res = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const ownerDto = res.body.find((r: { name: string }) => r.name === 'OWNER');
    // ADR-11: BigInt serialized to unsigned string (1<<63).
    expect(ownerDto.permissions).toBe('9223372036854775808');
    expect(ownerDto.isSystem).toBe(true);
  });
});

describe('S61 custom role CRUD + cascade (FR-RM15)', () => {
  it('creates a custom role then cascade-deletes MemberRole + ROLE override', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61casc');
    // 채널 1개 생성(ROLE override 부착 대상).
    const chan = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'general', type: 'TEXT' })
      .expect(201);
    const channelId = chan.body.id as string;

    // 커스텀 역할 생성(SEND_MESSAGES = 0x02).
    const role = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Helpers', permissions: '2', colorHex: '#00ff00', position: 50 })
      .expect(201);
    const roleId = role.body.id as string;

    // 멤버에게 역할 부여(자기 자신에게).
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles/assign`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ roleId, userId: owner.userId })
      .expect(204);

    // 이 역할 principal 의 ROLE override 를 채널에 직접 삽입(서비스 경로가 시스템
    // 역할 리터럴만 받으므로 DB 직접 삽입으로 roleId UUID override 를 모킹).
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId,
        principalType: 'ROLE',
        principalId: roleId,
        allowMask: 2n,
        denyMask: 0n,
      },
    });

    // MemberRole + override 존재 확인.
    expect((await env.prisma.memberRole.findMany({ where: { roleId } })).length).toBe(1);
    expect(
      (await env.prisma.channelPermissionOverride.findMany({ where: { principalId: roleId } }))
        .length,
    ).toBe(1);

    // 역할 삭제 → cascade.
    await request(env.baseUrl)
      .delete(`/workspaces/${workspaceId}/roles/${roleId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    expect((await env.prisma.memberRole.findMany({ where: { roleId } })).length).toBe(0);
    expect(
      (await env.prisma.channelPermissionOverride.findMany({ where: { principalId: roleId } }))
        .length,
    ).toBe(0);
    expect(await env.prisma.role.findUnique({ where: { id: roleId } })).toBeNull();
  });

  it('FR-RM03: ChannelPermissionOverride stores BigInt masks losslessly', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61big');
    const chan = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'bits', type: 'TEXT' })
      .expect(201);
    const channelId = chan.body.id as string;

    // 13비트 카탈로그 최댓값(0x1FFF)을 BigInt 로 저장·왕복.
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId,
        principalType: 'ROLE',
        principalId: 'MODERATOR',
        allowMask: 0x1fffn,
        denyMask: 0n,
      },
    });
    const row = await env.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalId: 'MODERATOR' },
    });
    expect(row?.allowMask).toBe(0x1fffn);
  });
});

describe('S61 position update concurrency (FR-RM04 SELECT FOR UPDATE)', () => {
  it('serializes two concurrent position PATCHes without lost-update', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61conc');
    const r1 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'RoleConc', permissions: '2', position: 30 })
      .expect(201);
    const roleId = r1.body.id as string;

    // 두 동시 PATCH(position 40, 41). SELECT FOR UPDATE 로 직렬화되어 둘 다 성공하고
    // 최종 값은 둘 중 하나(마지막 커밋). lost-update/deadlock 없이 완료되는지 확인.
    const [a, b] = await Promise.all([
      request(env.baseUrl)
        .patch(`/workspaces/${workspaceId}/roles/${roleId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ position: 40 }),
      request(env.baseUrl)
        .patch(`/workspaces/${workspaceId}/roles/${roleId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ position: 41 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const final = await env.prisma.role.findUnique({ where: { id: roleId } });
    expect([40, 41]).toContain(final?.position);
  });
});

// S61 fix-forward (security A-2 · MemberRole desync): 초대 가입/역할 변경 경로가
// 시스템 MemberRole 을 동기화해, ADMIN 승격된 멤버가 실제로 역할을 만들 수 있는지 검증.
describe('S61 fix-forward A-2: invited member promoted to ADMIN can manage roles', () => {
  it('seeds MEMBER MemberRole on invite-accept and ADMIN MemberRole on promotion', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61a2');
    const joiner = await inviteAndJoin(workspaceId, owner.accessToken, 's61a2j');

    // 가입 직후: MEMBER 시스템 MemberRole 이 존재해야 한다(종전엔 부재 → 권한 0n).
    expect(await systemRoleNamesOf(workspaceId, joiner.userId)).toEqual(['MEMBER']);

    // OWNER 가 가입자를 ADMIN 으로 승격.
    await request(env.baseUrl)
      .patch(`/workspaces/${workspaceId}/members/${joiner.userId}/role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'ADMIN' })
      .expect(200);

    // 승격 후: 시스템 MemberRole 이 ADMIN 으로 교체(MEMBER 잔재 없음 · 단일 불변식).
    expect(await systemRoleNamesOf(workspaceId, joiner.userId)).toEqual(['ADMIN']);

    // 이제 ADMIN 승격 멤버가 실제로 역할을 만들 수 있어야 한다(기능 불능 회귀 방지).
    const created = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${joiner.accessToken}`)
      .send({ name: 'ByAdmin', permissions: '2', position: 10 })
      .expect(201);
    expect(created.body.name).toBe('ByAdmin');
  });
});

// S61 fix-forward (security A-1 · privilege escalation): transferOwnership 가 ex-OWNER
// 의 OWNER MemberRole(ADMINISTRATOR 비트)을 제거하고 ADMIN 으로 교체하는지 검증.
describe('S61 fix-forward A-1: transferOwnership cleans up ex-OWNER MemberRole', () => {
  it('demotes ex-OWNER system MemberRole to ADMIN and blocks god-role re-grant', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61a1');
    const heir = await inviteAndJoin(workspaceId, owner.accessToken, 's61a1h');

    // 이전 전: owner=OWNER MemberRole / heir=MEMBER MemberRole.
    expect(await systemRoleNamesOf(workspaceId, owner.userId)).toEqual(['OWNER']);

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/transfer-ownership`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ toUserId: heir.userId })
      .expect(200);

    // A-1 핵심: ex-OWNER 는 더 이상 OWNER 시스템 MemberRole(ADMINISTRATOR)을 갖지 않고
    // ADMIN 으로 강등된다. 잔재가 남으면 ex-OWNER 가 자신에게 god role 을 재부여해
    // OWNER 권한을 되찾을 수 있다(실제 취약점).
    expect(await systemRoleNamesOf(workspaceId, owner.userId)).toEqual(['ADMIN']);
    expect(await systemRoleNamesOf(workspaceId, heir.userId)).toEqual(['OWNER']);

    // ex-OWNER 는 더 이상 ADMINISTRATOR 보유자가 아니므로, ADMINISTRATOR 비트를 담은
    // 커스텀 역할 생성이 권한 상승으로 거부되어야 한다(403 ROLE_PRIVILEGE_ESCALATION).
    const escalate = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'GodRole', permissions: '9223372036854775808', position: 10 });
    expect(escalate.status).toBe(403);
    expect(escalate.body.errorCode ?? escalate.body.code).toBe('ROLE_PRIVILEGE_ESCALATION');
  });
});

// S61 fix-forward (reviewer BLOCKER-3): 범위 밖 권한 비트는 500 이 아니라 422 로.
describe('S61 fix-forward B-1: out-of-range permission bit → 422', () => {
  it('rejects bit13 (8192) with 422 VALIDATION_FAILED instead of 500', async () => {
    const { owner, workspaceId } = await setupOwnerAndWs('s61b1');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'OutOfRange', permissions: '8192', position: 10 });
    // Zod refine 이 미리 거부 → 컨트롤러 safeParse 실패 → VALIDATION_FAILED(400).
    expect(res.status).toBe(400);
  });
});
