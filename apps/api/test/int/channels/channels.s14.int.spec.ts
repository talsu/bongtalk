/**
 * S14 (D02) 통합 테스트 — FR-CH-11 / FR-CH-05 / FR-CH-07.
 *
 * 기존 channels.int.spec.ts / channels.member-override.int.spec.ts 의 무회귀는
 * 그대로 두고, 본 슬라이스의 신규 동작만 별도 파일로 검증한다:
 *  - FR-CH-11: ROLE override 설정 엔드포인트(OWNER/ADMIN) + 마스크 범위 검증 +
 *    5단계 권한 계산 순서(개인 ALLOW 가 역할 DENY 를 이긴다)를 접근 경로로 고정.
 *  - FR-CH-05: 비공개→공개 전환 confirmName 토큰 검증(누락/불일치 거부, 일치 통과,
 *    공개→비공개는 토큰 불요) + channel.updated 발행.
 *  - FR-CH-07: 공개 채널 자유 가입 / 비공개 가입 거부 / 탈퇴 + 읽기 상태 보존 +
 *    member_added / member_removed 이벤트.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ChIntEnv, ORIGIN, setupChIntEnv, seedWorkspaceWithRoles, bearer } from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

// 각 테스트마다 신선한 워크스페이스를 시드한다. fractional position 은
// Decimal(20,10) 상한(절댓값 < 10^10)을 가지며 POSITION_STRIDE=10^9 이므로
// 한 워크스페이스에 10개째 채널을 append 하면 오버플로한다(선제존재 positioning
// 한도, S14 범위 밖). 테스트별 신선 시드로 워크스페이스당 채널 수를 1~2개로
// 유지해 이 한도를 우회한다.
beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  seed = await seedWorkspaceWithRoles(env.baseUrl);
});

const rnd = () => Math.random().toString(36).slice(2, 8);

async function createChannel(
  token: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

async function patchChannel(
  token: string,
  channelId: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(env.baseUrl)
    .patch(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send(body);
}

// Permission enforcement bits (auth/permissions Permission enum, 0xFF set).
const READ = 0x0001;
const WRITE = 0x0002;
const PIN = 0x0080;

describe('S14 FR-CH-11 — ROLE override endpoint', () => {
  it('OWNER/ADMIN can set a ROLE override; persists principalType=ROLE', async () => {
    const channelId = (await createChannel(seed.admin.accessToken, { name: `role-${rnd()}` })).body
      .id as string;

    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/roles`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ role: 'MEMBER', allowMask: PIN, denyMask: 0 });
    expect(res.status).toBe(201);
    expect(res.body.override.principalType).toBe('ROLE');
    expect(res.body.override.principalId).toBe('MEMBER');
    expect(res.body.override.allowMask).toBe(PIN);

    const row = await env.prisma.channelPermissionOverride.findUnique({
      where: {
        channelId_principalType_principalId: {
          channelId,
          principalType: 'ROLE',
          principalId: 'MEMBER',
        },
      },
    });
    expect(row?.allowMask).toBe(PIN);
  });

  it('rejects an out-of-enforcement-set mask (0x100) with 400 VALIDATION_FAILED', async () => {
    const channelId = (await createChannel(seed.admin.accessToken, { name: `role-oob-${rnd()}` }))
      .body.id as string;
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/roles`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ role: 'MEMBER', allowMask: 0x100 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('forbids a plain MEMBER from setting a ROLE override (403)', async () => {
    const channelId = (await createChannel(seed.admin.accessToken, { name: `role-403-${rnd()}` }))
      .body.id as string;
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/roles`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ role: 'MEMBER', allowMask: PIN });
    expect(res.status).toBe(403);
  });

  // FR-CH-11 5단계 순서: 개인 ALLOW 가 역할 DENY 를 이긴다. 비공개 채널에서
  // 역할 DENY(READ) 를 깔고, 개인 ALLOW(READ) 를 부여하면 가시성이 살아난다.
  it('개인 ALLOW 가 역할 DENY 를 이긴다 — 접근 경로로 고정 (private READ 가시성)', async () => {
    const channelId = (
      await createChannel(seed.admin.accessToken, { name: `ord-${rnd()}`, isPrivate: true })
    ).body.id as string;

    // 역할 DENY: MEMBER 역할에 READ 를 deny.
    await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/roles`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ role: 'MEMBER', allowMask: 0, denyMask: READ });

    // 개인 ALLOW 전: member 는 비공개 채널이 보이지 않음(GET → 403).
    const before = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(before.status).toBe(403);

    // 개인 ALLOW: member 본인에 READ|WRITE 부여.
    await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(seed.admin.accessToken))
      .send({ userId: seed.member.userId, allowMask: READ | WRITE, denyMask: 0 });

    // 개인 ALLOW(READ) 가 역할 DENY(READ) 를 이김 → 이제 가시(GET 200).
    const after = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(after.status).toBe(200);
    expect(after.body.id).toBe(channelId);
  });
});

describe('S14 FR-CH-05 — public/private flip confirm token', () => {
  it('private→public WITHOUT confirmName is rejected (400 CHANNEL_CONFIRM_REQUIRED)', async () => {
    const name = `flip-a-${rnd()}`;
    const channelId = (await createChannel(seed.admin.accessToken, { name, isPrivate: true })).body
      .id as string;

    const res = await patchChannel(seed.admin.accessToken, channelId, { isPrivate: false });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('CHANNEL_CONFIRM_REQUIRED');

    // 미적용 확인: 여전히 비공개.
    const row = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(row?.isPrivate).toBe(true);
  });

  it('private→public with a MISMATCHED confirmName is rejected (400)', async () => {
    const name = `flip-b-${rnd()}`;
    const channelId = (await createChannel(seed.admin.accessToken, { name, isPrivate: true })).body
      .id as string;
    const res = await patchChannel(seed.admin.accessToken, channelId, {
      isPrivate: false,
      confirmName: `${name}-wrong`,
    });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('CHANNEL_CONFIRM_REQUIRED');
  });

  it('private→public with the EXACT confirmName succeeds and flips isPrivate', async () => {
    const name = `flip-c-${rnd()}`;
    const channelId = (await createChannel(seed.admin.accessToken, { name, isPrivate: true })).body
      .id as string;
    const res = await patchChannel(seed.admin.accessToken, channelId, {
      isPrivate: false,
      confirmName: name,
    });
    expect(res.status).toBe(200);
    expect(res.body.isPrivate).toBe(false);

    // channel.updated outbox event recorded.
    const ev = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'channel.updated', aggregateId: channelId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(ev).toBeTruthy();
  });

  it('public→private requires NO confirmName (token unnecessary)', async () => {
    const name = `flip-d-${rnd()}`;
    const channelId = (await createChannel(seed.admin.accessToken, { name, isPrivate: false })).body
      .id as string;
    const res = await patchChannel(seed.admin.accessToken, channelId, { isPrivate: true });
    expect(res.status).toBe(200);
    expect(res.body.isPrivate).toBe(true);
  });

  it('a non-privacy PATCH (topic only) needs no confirmName', async () => {
    const name = `flip-e-${rnd()}`;
    const channelId = (await createChannel(seed.admin.accessToken, { name, isPrivate: true })).body
      .id as string;
    const res = await patchChannel(seed.admin.accessToken, channelId, { topic: '새 토픽' });
    expect(res.status).toBe(200);
    // 비공개 유지.
    const row = await env.prisma.channel.findUnique({ where: { id: channelId } });
    expect(row?.isPrivate).toBe(true);
  });
});

describe('S14 FR-CH-07 — channel join / leave', () => {
  it('a MEMBER can freely join a PUBLIC channel → member_added event + self override', async () => {
    const channelId = (
      await createChannel(seed.admin.accessToken, { name: `join-${rnd()}`, isPrivate: false })
    ).body.id as string;

    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/join`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(seed.member.userId);

    const ovr = await env.prisma.channelPermissionOverride.findUnique({
      where: {
        channelId_principalType_principalId: {
          channelId,
          principalType: 'USER',
          principalId: seed.member.userId,
        },
      },
    });
    expect(ovr).toBeTruthy();
    // review S14 HIGH fix: the join override is a pure opt-in marker (allowMask 0),
    // NOT 0xFF — a 0xFF self-join would override an ADMIN-set role DENY under the
    // 5-stage fold (개인 ALLOW > 역할 DENY) and escalate privileges. Pin it to 0.
    expect(ovr?.allowMask).toBe(0);

    const ev = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'channel.member_added', aggregateId: channelId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(ev).toBeTruthy();
    expect((ev?.payload as { userId?: string }).userId).toBe(seed.member.userId);
  });

  it('joining a PRIVATE channel is rejected (403 CHANNEL_PRIVATE_INVITE_ONLY)', async () => {
    const channelId = (
      await createChannel(seed.admin.accessToken, { name: `joinp-${rnd()}`, isPrivate: true })
    ).body.id as string;
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/join`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe('CHANNEL_PRIVATE_INVITE_ONLY');
  });

  it('leave removes the override, emits member_removed, and PRESERVES read state', async () => {
    const channelId = (
      await createChannel(seed.admin.accessToken, { name: `leave-${rnd()}`, isPrivate: false })
    ).body.id as string;

    // member joins.
    await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/join`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));

    // Seed a read-state row so we can prove it survives the leave. (We
    // insert directly — the ack path is exercised elsewhere; here we only
    // assert leave does not touch it.)
    await env.prisma.userChannelReadState.create({
      data: {
        userId: seed.member.userId,
        channelId,
        lastReadEventId: '00000000-0000-0000-0000-000000000000',
      },
    });

    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/leave`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(res.status).toBe(200);

    // override gone.
    const ovr = await env.prisma.channelPermissionOverride.findUnique({
      where: {
        channelId_principalType_principalId: {
          channelId,
          principalType: 'USER',
          principalId: seed.member.userId,
        },
      },
    });
    expect(ovr).toBeNull();

    // read state PRESERVED (FR-CH-07).
    const rs = await env.prisma.userChannelReadState.findUnique({
      where: { userId_channelId: { userId: seed.member.userId, channelId } },
    });
    expect(rs).toBeTruthy();

    // member_removed event.
    const ev = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'channel.member_removed', aggregateId: channelId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(ev).toBeTruthy();
  });

  it('leaving a channel you never joined → 409 CHANNEL_NOT_MEMBER', async () => {
    const channelId = (
      await createChannel(seed.admin.accessToken, { name: `leave-none-${rnd()}`, isPrivate: false })
    ).body.id as string;
    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/leave`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('CHANNEL_NOT_MEMBER');
  });
});
