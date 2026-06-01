import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import {
  bearer,
  type Actor,
  type ChIntEnv,
  ORIGIN,
  seedWorkspaceWithRoles,
  setupChIntEnv,
} from './helpers';

/**
 * S23 (FR-RS-11) integration spec — POST /workspaces/:id/read-all.
 *
 *  - 워크스페이스의 미읽 채널을 모두 0 으로 누른다(monotonic 전진).
 *  - 이미 읽은 채널은 건드리지 않는다(read_state:updated fan-out 대상에서 제외).
 *  - 채널별 read_state:updated 가 호출자의 user 룸으로 fan-out 된다.
 *
 * One workspace seeded ONCE in beforeAll (slug derives from the clock). Each
 * test creates freshly-named channels so cursors don't bleed.
 */
let env: ChIntEnv;
let workspaceId: string;
let owner: Actor;
let member: Actor;
let chSeq = 0;

beforeAll(async () => {
  env = await setupChIntEnv();
  const seed = await seedWorkspaceWithRoles(env.baseUrl);
  workspaceId = seed.workspaceId;
  owner = seed.owner;
  member = seed.member;
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

async function createChannel(opts?: {
  isPrivate?: boolean;
  ws?: string;
  by?: Actor;
}): Promise<string> {
  chSeq += 1;
  const wsId = opts?.ws ?? workspaceId;
  const by = opts?.by ?? owner;
  const res = await request(env.baseUrl)
    .post(`/workspaces/${wsId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(by.accessToken))
    .send({ name: `readall-ch-${chSeq}`, type: 'TEXT', isPrivate: opts?.isPrivate ?? false });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function postMessage(
  channelId: string,
  content: string,
  opts?: { ws?: string; by?: Actor },
): Promise<string> {
  const wsId = opts?.ws ?? workspaceId;
  const by = opts?.by ?? owner;
  const res = await request(env.baseUrl)
    .post(`/workspaces/${wsId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(by.accessToken))
    .send({ content });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

function unreadFor(
  channels: Array<{ channelId: string; unreadCount: number }>,
  id: string,
): number | undefined {
  return channels.find((c) => c.channelId === id)?.unreadCount;
}

function connect(accessToken: string): Promise<Socket> {
  const socket = ioClient(env.baseUrl, {
    auth: { accessToken },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

describe('S23 read-all (FR-RS-11)', () => {
  it('marks every unread channel read in one call (unread → 0)', async () => {
    const chA = await createChannel();
    const chB = await createChannel();
    await postMessage(chA, 'a1');
    await postMessage(chA, 'a2');
    await postMessage(chB, 'b1');

    // member has no cursor yet → 2 + 1 unread.
    const before = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(unreadFor(before.body.channels, chA)).toBe(2);
    expect(unreadFor(before.body.channels, chB)).toBe(1);

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.channelsRead).toBeGreaterThanOrEqual(2);

    const after = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(unreadFor(after.body.channels, chA)).toBe(0);
    expect(unreadFor(after.body.channels, chB)).toBe(0);
  });

  it('is idempotent — a second read-all with no new messages reads 0 channels', async () => {
    const ch = await createChannel();
    await postMessage(ch, 'x1');

    const first = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.channelsRead).toBeGreaterThanOrEqual(1);

    const second = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(second.status).toBe(200);
    // 모든 채널이 이미 읽음 → 미읽 채널 0개.
    expect(second.body.channelsRead).toBe(0);
  });

  it('fans read_state:updated to the caller user room for each channel read', async () => {
    const ch = await createChannel();
    await postMessage(ch, 'f1');
    await postMessage(ch, 'f2');

    const socket = await connect(member.accessToken);
    try {
      const events: Array<{ channelId: string; unreadCount: number }> = [];
      socket.on('read_state:updated', (e: { channelId: string; unreadCount: number }) =>
        events.push(e),
      );

      const res = await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/read-all`)
        .set('origin', ORIGIN)
        .set(bearer(member.accessToken));
      expect(res.status).toBe(200);

      // give the fan-out a moment to land on the socket.
      await new Promise((r) => setTimeout(r, 300));
      const forCh = events.find((e) => e.channelId === ch);
      expect(forCh).toBeDefined();
      expect(forCh?.unreadCount).toBe(0);
    } finally {
      socket.disconnect();
    }
  });

  // S23 fix-forward (MAJOR-4): set-based 단일 SQL 검증 — 대량 채널을 한 번에
  // 0 으로 누르고, 즉시 두 번째 호출은 idempotent(0 채널)임을 확인한다. 채널
  // position(Decimal 20,10) 오버플로(append STRIDE 누적)를 피하려고 fresh
  // workspace 를 쓴다(공유 ws 누적과 분리 — calcBetween 한계, 무관 회귀 방지).
  it('marks many unread channels read in one set-based call (대량 + idempotent)', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const N = 9;
    const channels: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const c = await createChannel({ ws: seed.workspaceId, by: seed.owner });
      await postMessage(c, `bulk-${i}`, { ws: seed.workspaceId, by: seed.owner });
      channels.push(c);
    }

    const before = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    for (const c of channels) expect(unreadFor(before.body.channels, c)).toBe(1);

    const res = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.channelsRead).toBeGreaterThanOrEqual(N);

    const after = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    for (const c of channels) expect(unreadFor(after.body.channels, c)).toBe(0);

    // 즉시 재호출 → 모든 채널이 이미 monotonic 최신 → 전진할 채널 0(idempotent).
    const second = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(second.status).toBe(200);
    expect(second.body.channelsRead).toBe(0);
  });

  // S23 fix-forward (MAJOR-4): ACL 가시성 — member 가 볼 수 없는 비공개 채널은
  // read-all 의 set-based SQL 에서 제외돼 fan-out/전진 대상이 아니다.
  it('excludes channels the caller cannot see (private channel not advanced)', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const priv = await createChannel({
      isPrivate: true,
      ws: seed.workspaceId,
      by: seed.owner,
    });
    await postMessage(priv, 'secret-1', { ws: seed.workspaceId, by: seed.owner });
    const open = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    await postMessage(open, 'open-1', { ws: seed.workspaceId, by: seed.owner });

    // member 는 비공개 채널을 unread-summary 에서조차 보지 못한다.
    const before = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(before.body.channels, priv)).toBeUndefined();
    expect(unreadFor(before.body.channels, open)).toBe(1);

    const socket = await connect(seed.member.accessToken);
    try {
      const events: Array<{ channelId: string }> = [];
      socket.on('read_state:updated', (e: { channelId: string }) => events.push(e));

      const res = await request(env.baseUrl)
        .post(`/workspaces/${seed.workspaceId}/read-all`)
        .set('origin', ORIGIN)
        .set(bearer(seed.member.accessToken));
      expect(res.status).toBe(200);

      await new Promise((r) => setTimeout(r, 300));
      // 비공개 채널은 fan-out 대상에서 제외.
      expect(events.some((e) => e.channelId === priv)).toBe(false);
      // owner 는 비공개 채널 작성자라 자기 메시지도 미읽으로 집계(FR-RS-03) →
      // member 의 read-all 이 비공개 채널을 건드리지 않았다는 방증.
      const ownerView = await request(env.baseUrl)
        .get(`/workspaces/${seed.workspaceId}/unread-summary`)
        .set('origin', ORIGIN)
        .set(bearer(seed.owner.accessToken));
      expect(unreadFor(ownerView.body.channels, priv)).toBe(1);
    } finally {
      socket.disconnect();
    }
  });
});
