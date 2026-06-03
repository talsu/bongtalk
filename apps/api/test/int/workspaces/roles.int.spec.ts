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
