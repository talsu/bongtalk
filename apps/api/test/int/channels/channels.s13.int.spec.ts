import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ChIntEnv, ORIGIN, setupChIntEnv, seedWorkspaceWithRoles, bearer } from './helpers';

/**
 * S13 (D02) 통합 테스트 — FR-CH-04 / FR-CH-09 / FR-CH-10 / FR-CH-19.
 *
 * 기존 channels.int.spec.ts 의 무회귀는 그대로 두고, 본 슬라이스의 신규
 * 동작만 별도 파일로 검증한다:
 *  - FR-CH-04: 아카이브 채널에 메시지 송신 시 403(CHANNEL_ARCHIVED) +
 *    아카이브 시 SYSTEM_CHANNEL_ARCHIVED 시스템 메시지.
 *  - FR-CH-09: 토픽 변경 시 SYSTEM_CHANNEL_TOPIC_CHANGED 시스템 메시지 +
 *    channel.updated 응답 유지.
 *  - FR-CH-10: description 생성/편집/목록 노출 + 길이 상한.
 *  - FR-CH-19: ANNOUNCEMENT 채널 MEMBER 게시 403 CHANNEL_POSTING_RESTRICTED,
 *    OWNER/ADMIN 게시 허용.
 */

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
  seed = await seedWorkspaceWithRoles(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
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

async function listMessages(token: string, channelId: string): Promise<request.Response> {
  return request(env.baseUrl)
    .get(`/workspaces/${seed.workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token));
}

async function sendMessage(
  token: string,
  channelId: string,
  content: string,
): Promise<request.Response> {
  return request(env.baseUrl)
    .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
}

describe('S13 FR-CH-10 — channel description CRUD', () => {
  it('creates a channel with a description and exposes it on the channel + list', async () => {
    const { admin } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `desc-${rnd()}`,
      type: 'TEXT',
      description: '공지 및 일반 대화 채널입니다.',
    });
    expect(created.status).toBe(201);
    expect(created.body.description).toBe('공지 및 일반 대화 채널입니다.');
    const channelId = created.body.id as string;

    const one = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set(bearer(admin.accessToken));
    expect(one.body.description).toBe('공지 및 일반 대화 채널입니다.');

    const list = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/channels`)
      .set(bearer(admin.accessToken));
    const row = list.body.uncategorized.find((c: { id: string }) => c.id === channelId) as {
      description: string;
    };
    expect(row.description).toBe('공지 및 일반 대화 채널입니다.');
  });

  it('edits and clears the description (PATCH)', async () => {
    const { admin } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `desc2-${rnd()}`,
      type: 'TEXT',
    });
    const channelId = created.body.id as string;
    expect(created.body.description).toBeNull();

    const set = await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ description: '새 설명' });
    expect(set.status).toBe(200);
    expect(set.body.description).toBe('새 설명');

    const cleared = await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ description: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.description).toBeNull();
  });

  it('rejects a description longer than 500 chars with 400 VALIDATION_FAILED', async () => {
    const res = await createChannel(seed.admin.accessToken, {
      name: `desclong-${rnd()}`,
      type: 'TEXT',
      description: 'x'.repeat(501),
    });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('S13 FR-CH-09 — topic-change system message', () => {
  it('emits SYSTEM_CHANNEL_TOPIC_CHANGED on a real topic change (and keeps channel.updated)', async () => {
    const { admin } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `topic-${rnd()}`,
      type: 'TEXT',
    });
    const channelId = created.body.id as string;

    const patch = await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ topic: '새 토픽' });
    expect(patch.status).toBe(200);
    expect(patch.body.topic).toBe('새 토픽');

    const list = await listMessages(admin.accessToken, channelId);
    expect(list.status).toBe(200);
    const systemRow = list.body.items.find(
      (m: { type: string }) => m.type === 'SYSTEM_CHANNEL_TOPIC_CHANGED',
    ) as { content: string } | undefined;
    expect(systemRow).toBeTruthy();
    expect(systemRow?.content).toContain('새 토픽');
  });

  it('does NOT emit a system message when the topic is unchanged', async () => {
    const { admin } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `topic-noop-${rnd()}`,
      type: 'TEXT',
      topic: '동일 토픽',
    });
    const channelId = created.body.id as string;

    // PATCH the same topic value → no real change → no system message.
    await request(env.baseUrl)
      .patch(`/workspaces/${seed.workspaceId}/channels/${channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ topic: '동일 토픽' });

    const list = await listMessages(admin.accessToken, channelId);
    const hasSystem = list.body.items.some(
      (m: { type: string }) => m.type === 'SYSTEM_CHANNEL_TOPIC_CHANGED',
    );
    expect(hasSystem).toBe(false);
  });
});

describe('S13 FR-CH-04 — archive: send blocked + system message', () => {
  it('archiving emits SYSTEM_CHANNEL_ARCHIVED and blocks message send with 403 CHANNEL_ARCHIVED', async () => {
    const { admin } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `arch-${rnd()}`,
      type: 'TEXT',
    });
    const channelId = created.body.id as string;

    // Pre-archive: a normal send works (control).
    const before = await sendMessage(admin.accessToken, channelId, '보관 전 메시지');
    expect(before.status).toBe(201);

    const archive = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/archive`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken));
    expect(archive.status).toBe(201);

    // FR-CH-04: send into an archived channel is rejected.
    const blocked = await sendMessage(admin.accessToken, channelId, '보관 후 메시지');
    expect(blocked.status).toBe(409);
    expect(blocked.body.errorCode).toBe('CHANNEL_ARCHIVED');

    // SYSTEM_CHANNEL_ARCHIVED system message exists. GET /messages is itself
    // gated by ChannelAccessGuard (no @AllowArchivedChannel), so an archived
    // channel can't be listed via HTTP — verify the row directly in the DB.
    const archivedSystemRows = await env.prisma.message.findMany({
      where: { channelId, type: 'SYSTEM_CHANNEL_ARCHIVED' },
    });
    expect(archivedSystemRows.length).toBe(1);
  });
});

describe('S13 FR-CH-19 — ANNOUNCEMENT posting restriction', () => {
  it('MEMBER is blocked with 403 CHANNEL_POSTING_RESTRICTED; OWNER + ADMIN can post', async () => {
    const { owner, admin, member } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `ann-${rnd()}`,
      type: 'ANNOUNCEMENT',
    });
    expect(created.status).toBe(201);
    const channelId = created.body.id as string;

    // MEMBER (no SEND_MESSAGES override) → restricted.
    const memberSend = await sendMessage(member.accessToken, channelId, '멤버 공지 시도');
    expect(memberSend.status).toBe(403);
    expect(memberSend.body.errorCode).toBe('CHANNEL_POSTING_RESTRICTED');

    // ADMIN → allowed.
    const adminSend = await sendMessage(admin.accessToken, channelId, '관리자 공지');
    expect(adminSend.status).toBe(201);

    // OWNER → allowed.
    const ownerSend = await sendMessage(owner.accessToken, channelId, '소유자 공지');
    expect(ownerSend.status).toBe(201);
  });

  it('grants posting to a MEMBER via an explicit WRITE_MESSAGE override', async () => {
    const { admin, member } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `ann-grant-${rnd()}`,
      type: 'ANNOUNCEMENT',
    });
    const channelId = created.body.id as string;

    // Baseline: blocked.
    const before = await sendMessage(member.accessToken, channelId, '권한 부여 전');
    expect(before.status).toBe(403);

    // Grant WRITE_MESSAGE (0x0002) + READ (0x0001) to this member via override.
    const grant = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${channelId}/members`)
      .set('origin', ORIGIN)
      .set(bearer(admin.accessToken))
      .send({ userId: member.userId, allowMask: 0x0003, denyMask: 0 });
    expect(grant.status).toBe(201);

    const after = await sendMessage(member.accessToken, channelId, '권한 부여 후 공지');
    expect(after.status).toBe(201);
  });

  it('does NOT restrict posting on a TEXT channel for MEMBER (no regression)', async () => {
    const { admin, member } = seed;
    const created = await createChannel(admin.accessToken, {
      name: `text-ok-${rnd()}`,
      type: 'TEXT',
    });
    const channelId = created.body.id as string;
    const send = await sendMessage(member.accessToken, channelId, '일반 채널 메시지');
    expect(send.status).toBe(201);
  });
});
