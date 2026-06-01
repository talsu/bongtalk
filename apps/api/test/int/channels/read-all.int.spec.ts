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

  // ── S24 (FR-RS-18): snapshot + Undo ───────────────────────────────────────

  it('read-all returns a snapshotId and undo restores the prior unread state', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 's24-1', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 's24-2', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 's24-3', { ws: seed.workspaceId, by: seed.owner });

    // member 는 커서가 없어 3 미읽.
    const before = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(before.body.channels, ch)).toBe(3);

    const readAll = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(readAll.status).toBe(200);
    expect(readAll.body.snapshotId).toMatch(/^[0-9a-f-]{36}$/);

    // 전부 읽음.
    const afterRead = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(afterRead.body.channels, ch)).toBe(0);

    // Undo → 직전 상태(3 미읽)로 후진 복원.
    const undo = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ snapshotId: readAll.body.snapshotId });
    expect(undo.status).toBe(200);
    expect(undo.body.channelsRestored).toBeGreaterThanOrEqual(1);

    const afterUndo = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(afterUndo.body.channels, ch)).toBe(3);
  });

  it('undo restores a PARTIALLY-read channel to its exact prior cursor (후진)', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    const m1 = await postMessage(ch, 'p1', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'p2', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'p3', { ws: seed.workspaceId, by: seed.owner });

    // member ACK 까지 m1 → 남은 미읽 2(p2, p3).
    await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ lastReadMessageId: m1 });

    const before = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(before.body.channels, ch)).toBe(2);

    const readAll = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(readAll.status).toBe(200);

    // Undo → 정확히 직전 커서(m1)로 후진 → 미읽 2 복원.
    const undo = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ snapshotId: readAll.body.snapshotId });
    expect(undo.status).toBe(200);

    const afterUndo = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(afterUndo.body.channels, ch)).toBe(2);
  });

  it('undo with an unknown snapshotId returns 404', async () => {
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ snapshotId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(404);
  });

  // S24 fix-forward (security HIGH #1): consume 원자화 — 같은 snapshotId 로 두 번째
  // Undo 는 이미 소비돼 404(중복 복원 차단). 첫 Undo 가 Redis+DB 양쪽을 소비한다.
  it('double-undo with the same snapshotId returns 404 on the second call', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'd1', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'd2', { ws: seed.workspaceId, by: seed.owner });

    const readAll = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(readAll.status).toBe(200);
    const snapshotId = readAll.body.snapshotId as string;

    const first = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ snapshotId });
    expect(first.status).toBe(200);

    const second = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ snapshotId });
    expect(second.status).toBe(404);

    // 첫 복원만 적용 — 미읽 2(2 번째 Undo 가 추가 후진하지 않음).
    const after = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(after.body.channels, ch)).toBe(2);
  });

  // S24 fix-forward (security HIGH #1): owner-mismatch — 다른 사용자가 남의
  // snapshotId 로 Undo 하면 404 이고, 정당한 소유자의 스냅샷은 소비되지 않는다.
  it('rejects undo from a non-owner of the snapshot (404) without consuming it', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'o1', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'o2', { ws: seed.workspaceId, by: seed.owner });

    // member 가 read-all → member 소유 스냅샷.
    const readAll = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(readAll.status).toBe(200);
    const snapshotId = readAll.body.snapshotId as string;

    // owner(같은 워크스페이스 멤버라 가드는 통과)가 member 의 snapshotId 로 Undo →
    // owner-mismatch 404(소비 안 됨).
    const wrong = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.owner.accessToken))
      .send({ snapshotId });
    expect(wrong.status).toBe(404);

    // 정당한 소유자(member)는 여전히 Undo 가능 — 스냅샷이 소비되지 않았다.
    const right = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ snapshotId });
    expect(right.status).toBe(200);
    const after = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(after.body.channels, ch)).toBe(2);
  });

  // S24 fix-forward (reviewer MAJOR #2): snapshot RETURNING old-value 정합 —
  // read-all 이 덮어쓰기 직전 old 커서를 캡처하므로, read-all 직후 도착한 새
  // 메시지가 Undo 에 영향을 주지 않고(스냅샷은 read-all 시점 커서) 정확히 복원된다.
  it('undo restores to the read-all-time cursor even if new messages arrived after', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    const m1 = await postMessage(ch, 'c1', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'c2', { ws: seed.workspaceId, by: seed.owner });

    // member ACK 까지 m1 → 미읽 1(c2).
    await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ lastReadMessageId: m1 });
    expect(
      unreadFor(
        (
          await request(env.baseUrl)
            .get(`/workspaces/${seed.workspaceId}/unread-summary`)
            .set('origin', ORIGIN)
            .set(bearer(seed.member.accessToken))
        ).body.channels,
        ch,
      ),
    ).toBe(1);

    const readAll = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(readAll.status).toBe(200);

    // read-all 직후 새 메시지 2개 도착(read-all 스냅샷에는 없음).
    await postMessage(ch, 'c3', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'c4', { ws: seed.workspaceId, by: seed.owner });

    // Undo → read-all 시점 커서(m1)로 후진 → c2,c3,c4 미읽(3). 스냅샷이 read-all
    // 시점 old 커서라, 이후 도착 메시지도 자연히 미읽으로 집계된다.
    const undo = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken))
      .send({ snapshotId: readAll.body.snapshotId });
    expect(undo.status).toBe(200);

    const after = await request(env.baseUrl)
      .get(`/workspaces/${seed.workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(unreadFor(after.body.channels, ch)).toBe(3);
  });

  it('undo fans read_state:updated for each restored channel', async () => {
    const seed = await seedWorkspaceWithRoles(env.baseUrl);
    const ch = await createChannel({ ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'u1', { ws: seed.workspaceId, by: seed.owner });
    await postMessage(ch, 'u2', { ws: seed.workspaceId, by: seed.owner });

    const readAll = await request(env.baseUrl)
      .post(`/workspaces/${seed.workspaceId}/read-all`)
      .set('origin', ORIGIN)
      .set(bearer(seed.member.accessToken));
    expect(readAll.status).toBe(200);

    const socket = await connect(seed.member.accessToken);
    try {
      const events: Array<{ channelId: string; unreadCount: number }> = [];
      socket.on('read_state:updated', (e: { channelId: string; unreadCount: number }) =>
        events.push(e),
      );

      const undo = await request(env.baseUrl)
        .post(`/workspaces/${seed.workspaceId}/read-all/undo`)
        .set('origin', ORIGIN)
        .set(bearer(seed.member.accessToken))
        .send({ snapshotId: readAll.body.snapshotId });
      expect(undo.status).toBe(200);

      await new Promise((r) => setTimeout(r, 300));
      const forCh = events.find((e) => e.channelId === ch);
      expect(forCh).toBeDefined();
      // 복원 후 미읽이 다시 2 로 올라간 read_state:updated 가 fan-out 된다.
      expect(forCh?.unreadCount).toBe(2);
    } finally {
      socket.disconnect();
    }
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
