import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  bearer,
  type ChIntEnv,
  ORIGIN,
  seedWorkspaceWithRoles,
  setupChIntEnv,
} from '../channels/helpers';

let env: ChIntEnv;

beforeAll(async () => {
  env = await setupChIntEnv();
  // S28 int: 일부 시나리오(자정 걸침/만료/스케줄 종료)는 vi.setSystemTime 으로
  // 발급 시각보다 15분(기본 access TTL)을 넘겨 이동한다. token.service 는
  // process.env.ACCESS_TOKEN_TTL 을 sign 시점에 라이브로 읽으므로, 시드에서 발급되는
  // access token 의 exp 를 충분히 멀게 두기 위해 여기서 크게 키운다(다른 spec 에
  // 영향 없도록 본 파일 종료 시 원복).
  process.env.ACCESS_TOKEN_TTL = String(7 * 24 * 60 * 60);
}, 240_000);

afterAll(async () => {
  process.env.ACCESS_TOKEN_TTL = '900';
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(
  workspaceId: string,
  ownerToken: string,
  name: string,
): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(ownerToken))
    .send({ name, type: 'TEXT' });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

/**
 * 멘션은 본문의 `@username` 을 워크스페이스 멤버로 resolve 해 추출된다(서버 권위).
 * body.mentions.users 힌트는 user 멘션엔 반영되지 않으므로 username 을 본문에 싣는다.
 */
async function mention(
  workspaceId: string,
  channelId: string,
  token: string,
  targetUsername: string,
): Promise<void> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content: `heads up @${targetUsername}` });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
}

/** 특정 사용자를 대상으로 한 mention.received outbox 행 수. */
async function mentionOutboxCount(targetUserId: string): Promise<number> {
  return env.prisma.outboxEvent.count({
    where: { eventType: 'mention.received', aggregateId: targetUserId },
  });
}

/** 멤버목록(hoist + groups)을 평탄화해 userId 로 멤버 DTO 를 찾는다. */
type MemberDto = {
  userId: string;
  user: { customStatus: string | null; customStatusEmoji?: string | null };
};
function findMemberDto(
  body: {
    hoist: Array<{ members: MemberDto[] }>;
    groups: Array<{ members: MemberDto[] }>;
  },
  userId: string,
): MemberDto | undefined {
  const all: MemberDto[] = [
    ...body.hoist.flatMap((g) => g.members),
    ...body.groups.flatMap((g) => g.members),
  ];
  return all.find((m) => m.userId === userId);
}

/** thread.replied outbox payload 안의 recipients 에 targetUserId 가 들어있는 행 수. */
async function threadRepliedRecipientCount(targetUserId: string): Promise<number> {
  const rows = await env.prisma.outboxEvent.findMany({
    where: { eventType: 'message.thread.replied' },
    select: { payload: true },
  });
  let n = 0;
  for (const r of rows) {
    const recipients = (r.payload as { recipients?: string[] } | null)?.recipients ?? [];
    if (recipients.includes(targetUserId)) n++;
  }
  return n;
}

describe('S28 (FR-P04/P17) — 커스텀 상태 set/update/delete + expiresAt 프리셋 + lazy 만료', () => {
  it('PUT/GET/DELETE /users/me/status — emoji + text + expiresAt 구조화', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);

    // set
    const set = await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: '점심중', emoji: '🍜', expiresAt: '2025-01-01T02:00:00Z' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      text: '점심중',
      emoji: '🍜',
      expiresAt: '2025-01-01T02:00:00.000Z',
    });

    // get
    const get = await request(env.baseUrl)
      .get('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(get.status).toBe(200);
    expect(get.body.text).toBe('점심중');
    expect(get.body.emoji).toBe('🍜');

    // update (text only, emoji cleared)
    const upd = await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: '회의중', emoji: null });
    expect(upd.status).toBe(200);
    expect(upd.body).toEqual({ text: '회의중', emoji: null, expiresAt: null });

    // delete
    const del = await request(env.baseUrl)
      .delete('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ text: null, emoji: null, expiresAt: null });

    const after = await request(env.baseUrl)
      .get('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(after.body).toEqual({ text: null, emoji: null, expiresAt: null });
  });

  it('preset(one_hour) 은 timezone(Asia/Seoul) 기준으로 UTC expiresAt 계산', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    // now = 2025-01-01T00:00:00Z (frozen). one_hour → +1h, tz 무관 +1h.
    const res = await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: '집중', preset: 'one_hour', timezone: 'Asia/Seoul' });
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe('2025-01-01T01:00:00.000Z');
  });

  it('preset(today) 은 사용자 tz 자정을 UTC 로 — Asia/Seoul', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    // now=2025-01-01T00:00Z = 서울 09:00. 서울 오늘 자정(다음날 00:00) = UTC 15:00.
    const res = await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: '오늘만', preset: 'today', timezone: 'Asia/Seoul' });
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe('2025-01-01T15:00:00.000Z');
  });

  it('FR-P17 lazy 만료 — expiresAt 지난 뒤 GET 하면 빈 상태 반환', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: '잠깐', expiresAt: '2025-01-01T00:30:00Z' });

    // 만료 전: 그대로 보임
    vi.setSystemTime(new Date('2025-01-01T00:10:00Z'));
    const before = await request(env.baseUrl)
      .get('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(before.body.text).toBe('잠깐');

    // 만료 후: 빈 상태 (lazy clear)
    vi.setSystemTime(new Date('2025-01-01T00:31:00Z'));
    const after = await request(env.baseUrl)
      .get('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(after.body).toEqual({ text: null, emoji: null, expiresAt: null });
  });

  it('과거 expiresAt 은 400 VALIDATION_FAILED', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    const res = await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: 'x', expiresAt: '2024-12-31T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('S28 (FR-P05) — DND 수동 알림 차단', () => {
  it('수신자가 DND 면 mention.received outbox 미발송', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channelId = await createChannel(workspaceId, owner.accessToken, 'gen');

    // baseline: member 가 DND 아님 → mention 발송됨
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);

    // member 가 수동 DND 로 전환
    const presence = await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ status: 'dnd' });
    expect(presence.status).toBe(200);

    // DND 중 mention → outbox 추가 안 됨 (여전히 1)
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);
  });

  it('invisible 은 알림 차단 아님 — mention.received 정상 발송', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channelId = await createChannel(workspaceId, owner.accessToken, 'gen');

    await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ status: 'invisible' });

    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);
  });
});

describe('S28 (FR-P06) — DND 스케줄 알림 차단 + auto-toggle + 자정 걸침', () => {
  it('스케줄 구간 활성 시점에 mention 하면 차단 (수동 DND 아님)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channelId = await createChannel(workspaceId, owner.accessToken, 'gen');

    // 2025-01-01 = Wed(day=3). 12:30~13:00 구간을 DND 로. 비활성 시각(00:00Z, beforeEach
    // 고정)에 저장하므로 auto-toggle 이 presence 를 건드리지 않는다(presence=auto 유지)
    // → 차단은 순수하게 "send-time 에 스케줄 구간이 활성인가"만 반영한다.
    await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 12 * 60 + 30, endMin: 13 * 60 }] } });

    // 12:45Z → 구간 안. presence 는 여전히 auto 지만 스케줄 활성이라 차단.
    vi.setSystemTime(new Date('2025-01-01T12:45:00Z'));
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(0);

    // presencePreference 가 dnd 로 바뀌지 않았음을 명시 검증(스케줄만으로 차단).
    const row = await env.prisma.user.findUnique({
      where: { id: member.userId },
      select: { presencePreference: true },
    });
    expect(row?.presencePreference).toBe('auto');
  });

  it('PATCH /me/dnd-schedule auto-toggle: 활성 구간 저장 시 presence=dnd 진입', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    // 00:00~01:00 Wed → 현재(00:00Z) 활성. set 직후 진입.
    const set = await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 0, endMin: 60 }] } });
    expect(set.status).toBe(200);
    expect(set.body.preference).toBe('dnd');

    const row = await env.prisma.user.findUnique({
      where: { id: member.userId },
      select: { presencePreference: true, dndScheduleSnapshot: true },
    });
    expect(row?.presencePreference).toBe('dnd');
    expect(row?.dndScheduleSnapshot).toEqual({ prev: 'auto' });
  });

  it('auto-toggle 종료: 구간을 벗어난 시각에 GET 하면 이전 상태로 복원', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    // 00:00~01:00 Wed 저장 → 진입(dnd).
    await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 0, endMin: 60 }] } });

    // 구간 밖(02:00Z)으로 시간 이동 후 GET → 종료 복원(auto).
    vi.setSystemTime(new Date('2025-01-01T02:00:00Z'));
    const get = await request(env.baseUrl)
      .get('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(get.status).toBe(200);
    expect(get.body.preference).toBe('auto');

    const row = await env.prisma.user.findUnique({
      where: { id: member.userId },
      select: { presencePreference: true, dndScheduleSnapshot: true },
    });
    expect(row?.presencePreference).toBe('auto');
    expect(row?.dndScheduleSnapshot).toBeNull();
  });

  it('자정 걸침(start>end): 23:00→07:00 구간에서 12:00 비활성, 23:30 활성', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channelId = await createChannel(workspaceId, owner.accessToken, 'gen');

    // 스케줄 저장 시점의 auto-toggle 부작용(진입 시 presence=dnd)을 피하기 위해
    // 비활성 시각(12:00Z)에서 스케줄을 저장한다 → presence 는 auto 로 유지되고,
    // 이후 알림 게이트는 순수하게 "send-time 에 스케줄 구간이 활성인가"만 반영한다.
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    // Wed 23:00 → 07:00 overnight 스케줄.
    await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 23 * 60, endMin: 7 * 60 }] } });

    // 12:00Z → 비활성 → 발송(count 1).
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);

    // 23:30Z → 활성 → 차단(여전히 1).
    vi.setSystemTime(new Date('2025-01-01T23:30:00Z'));
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);
  });

  it('수동 DND 사용자는 스케줄 종료 시에도 DND 유지 (snapshot 미생성)', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);
    // 먼저 수동 DND.
    await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ status: 'dnd' });

    // 활성 구간 저장 → 이미 dnd 이므로 snapshot 생성 안 함(멱등).
    await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 0, endMin: 60 }] } });
    const mid = await env.prisma.user.findUnique({
      where: { id: member.userId },
      select: { dndScheduleSnapshot: true },
    });
    expect(mid?.dndScheduleSnapshot).toBeNull();

    // 구간 밖으로 이동 후 GET → snapshot 없으니 복원하지 않고 dnd 유지.
    vi.setSystemTime(new Date('2025-01-01T02:00:00Z'));
    const get = await request(env.baseUrl)
      .get('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(get.body.preference).toBe('dnd');
  });
});

describe('S28 (reviewer B1 BLOCKER) — 자정 걸침 다음날 새벽 carry', () => {
  it('Wed 23:00→07:00 → Thu 03:00 차단(carry), Wed 03:00 미차단(전날 entry 없음)', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channelId = await createChannel(workspaceId, owner.accessToken, 'gen');

    // 비활성 시각(12:00Z)에 저장해 auto-toggle 부작용(진입 시 presence=dnd)을 피한다.
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 23 * 60, endMin: 7 * 60 }] } });

    // Wed 03:00Z → 전날(Tue) overnight entry 없음 → carry 없음 → 발송(count 1).
    vi.setSystemTime(new Date('2025-01-01T03:00:00Z'));
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);

    // Thu 03:00Z(2025-01-02) → Wed entry 의 다음날 새벽 carry → 차단(여전히 1).
    vi.setSystemTime(new Date('2025-01-02T03:00:00Z'));
    await mention(workspaceId, channelId, owner.accessToken, member.username);
    expect(await mentionOutboxCount(member.userId)).toBe(1);
  });
});

describe('S28 (security HIGH-2 + FR-P17) — 만료 customStatus 멤버목록 마스킹', () => {
  it('만료된 customStatus(+emoji)는 타인 멤버목록에서 null 로 가려진다', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);

    // member 가 30분 후 만료되는 상태를 건다.
    await request(env.baseUrl)
      .put('/users/me/status')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ text: '점심중', emoji: '🍜', expiresAt: '2025-01-01T00:30:00Z' });

    // 만료 전: owner 가 보는 멤버목록에 노출.
    const before = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members?include_offline=true`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(before.status).toBe(200);
    const beforeDto = findMemberDto(before.body, member.userId);
    expect(beforeDto?.user.customStatus).toBe('점심중');
    expect(beforeDto?.user.customStatusEmoji).toBe('🍜');

    // 만료 후: 같은 목록에서 text/emoji 모두 null(마스킹) — DB lazy clear 없이도 가려짐.
    vi.setSystemTime(new Date('2025-01-01T00:31:00Z'));
    const after = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/members?include_offline=true`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken));
    expect(after.status).toBe(200);
    const afterDto = findMemberDto(after.body, member.userId);
    expect(afterDto?.user.customStatus).toBeNull();
    expect(afterDto?.user.customStatusEmoji).toBeNull();
  });
});

describe('S28 (reviewer M2) — 스케줄 중 수동 변경 시 종료 복원 안 함', () => {
  it('스케줄 진입 → 수동 invisible → 구간 종료 시 invisible 유지(수동값 보존)', async () => {
    const { member } = await seedWorkspaceWithRoles(env.baseUrl);

    // 00:00~01:00 Wed 저장 → 진입(dnd, snapshot={prev:auto}).
    await request(env.baseUrl)
      .patch('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ schedule: { days: [{ day: 3, startMin: 0, endMin: 60 }] } });

    // 구간 중 사용자가 수동으로 invisible 로 전환 → snapshot 클리어(스케줄 소유 해제).
    const presence = await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ status: 'invisible' });
    expect(presence.status).toBe(200);
    const mid = await env.prisma.user.findUnique({
      where: { id: member.userId },
      select: { presencePreference: true, dndScheduleSnapshot: true },
    });
    expect(mid?.presencePreference).toBe('invisible');
    expect(mid?.dndScheduleSnapshot).toBeNull();

    // 구간 밖(02:00Z)으로 이동 후 GET → snapshot 없으니 복원 안 함 → invisible 유지.
    vi.setSystemTime(new Date('2025-01-01T02:00:00Z'));
    const get = await request(env.baseUrl)
      .get('/me/dnd-schedule')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(get.status).toBe(200);
    expect(get.body.preference).toBe('invisible');
  });
});

describe('S28 (reviewer M3) — thread.replied 도 DND 수신자 제외', () => {
  it('수동 DND 인 thread root 작성자는 thread.replied recipients 에서 제외된다', async () => {
    const { workspaceId, owner, member } = await seedWorkspaceWithRoles(env.baseUrl);
    const channelId = await createChannel(workspaceId, owner.accessToken, 'gen');

    // member 가 thread root 작성 → owner 가 reply → member 는 root author 라 thread.replied
    // 수신 후보. (멘션은 쓰지 않아 mention 경로와 무관하게 thread 게이트만 검증.)
    const root = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ content: 'thread root' });
    expect(root.status).toBe(201);
    // 메시지 POST 응답 shape 은 { message: { id, ... } } 다.
    const rootId = root.body.message.id as string;

    // baseline: member 가 DND 아님 → owner reply 시 thread.replied recipients 에 member 포함.
    const r1 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'reply one', parentMessageId: rootId });
    expect(r1.status).toBe(201);
    expect(await threadRepliedRecipientCount(member.userId)).toBe(1);

    // member 가 수동 DND 전환.
    await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ status: 'dnd' });

    // DND 중 owner reply → thread.replied recipients 에서 member 제외(여전히 1).
    const r2 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(owner.accessToken))
      .send({ content: 'reply two', parentMessageId: rootId });
    expect(r2.status).toBe(201);
    expect(await threadRepliedRecipientCount(member.userId)).toBe(1);
  });
});
