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
 * S24 (FR-RS-08/09) integration spec — 수동 미읽(monotonic 후진) + 컨텍스트 읽음.
 *
 *  - POST /workspaces/:id/channels/:chid/unread {messageId} 는 지정 메시지 **직전**
 *    메시지로 lastReadMessageId 를 되돌린다(後進 — S21 monotonic guard 우회).
 *  - 직전 메시지가 없으면 전체 미읽(null 커서).
 *  - read_state:updated 가 호출자 user 룸으로 fan-out(멀티세션 배지).
 *  - ackRead(컨텍스트 메뉴 "읽음으로 표시" / FR-RS-09)는 종전대로 monotonic 전진 —
 *    후진 시도(stale ack)는 무회귀(no-op).
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

async function createChannel(): Promise<string> {
  chSeq += 1;
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set(bearer(owner.accessToken))
    .send({ name: `unread-ch-${chSeq}`, type: 'TEXT', isPrivate: false });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function postMessage(channelId: string, content: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(owner.accessToken))
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

async function summaryUnread(channelId: string): Promise<number | undefined> {
  const res = await request(env.baseUrl)
    .get(`/workspaces/${workspaceId}/unread-summary`)
    .set('origin', ORIGIN)
    .set(bearer(member.accessToken));
  return unreadFor(res.body.channels, channelId);
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

describe('S24 mark-unread (FR-RS-08) — monotonic 후진', () => {
  it('marks unread from a message → cursor regresses to its predecessor (unread 증가)', async () => {
    const ch = await createChannel();
    const m1 = await postMessage(ch, 'a1');
    const m2 = await postMessage(ch, 'a2');
    const m3 = await postMessage(ch, 'a3');

    // member 가 최신(m3)까지 읽음 → 미읽 0.
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m3 });
    expect(await summaryUnread(ch)).toBe(0);

    // m2 를 "미읽으로 표시" → 직전(m1)로 후진 → m2, m3 가 미읽(2).
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/unread`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ messageId: m2 });
    expect(res.status).toBe(200);
    expect(res.body.lastReadMessageId).toBe(m1);
    expect(res.body.unreadCount).toBe(2);
    expect(await summaryUnread(ch)).toBe(2);
  });

  it('marking the FIRST message unread regresses the cursor to null (전체 미읽)', async () => {
    const ch = await createChannel();
    const m1 = await postMessage(ch, 'b1');
    const m2 = await postMessage(ch, 'b2');

    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m2 });
    expect(await summaryUnread(ch)).toBe(0);

    // m1(첫 메시지)을 미읽 → 직전 없음 → null 커서 → 전체(2) 미읽.
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/unread`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ messageId: m1 });
    expect(res.status).toBe(200);
    expect(res.body.lastReadMessageId).toBeNull();
    expect(res.body.unreadCount).toBe(2);
    expect(await summaryUnread(ch)).toBe(2);
  });

  it('rejects a messageId from another channel with 404', async () => {
    const chA = await createChannel();
    const chB = await createChannel();
    const inB = await postMessage(chB, 'x');
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${chA}/unread`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ messageId: inB });
    expect(res.status).toBe(404);
  });

  it('fans read_state:updated to the caller user room', async () => {
    const ch = await createChannel();
    await postMessage(ch, 'c1');
    const m2 = await postMessage(ch, 'c2');
    await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m2 });

    const socket = await connect(member.accessToken);
    try {
      const events: Array<{ channelId: string; unreadCount: number }> = [];
      socket.on('read_state:updated', (e: { channelId: string; unreadCount: number }) =>
        events.push(e),
      );
      const res = await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${ch}/unread`)
        .set('origin', ORIGIN)
        .set(bearer(member.accessToken))
        .send({ messageId: m2 });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      const forCh = events.find((e) => e.channelId === ch);
      expect(forCh).toBeDefined();
      expect(forCh?.unreadCount).toBe(1);
    } finally {
      socket.disconnect();
    }
  });
});

describe('S24 context-menu read (FR-RS-09) — monotonic 전진 무회귀', () => {
  it('ack to latest reads the channel (전진) and a stale ack is a no-op (무회귀)', async () => {
    const ch = await createChannel();
    const m1 = await postMessage(ch, 'd1');
    await postMessage(ch, 'd2');
    const m3 = await postMessage(ch, 'd3');

    // 컨텍스트 메뉴 "읽음으로 표시" = 최신(m3)까지 ackRead 전진.
    const fwd = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m3 });
    expect(fwd.status).toBe(200);
    expect(await summaryUnread(ch)).toBe(0);

    // stale ack(m1) → monotonic guard 가 후진을 막아 커서 유지(무회귀).
    const stale = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${ch}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m1 });
    expect(stale.status).toBe(200);
    expect(stale.body.lastReadMessageId).toBe(m3); // 여전히 최신 커서.
    expect(await summaryUnread(ch)).toBe(0);
  });

  // S24 fix-forward (reviewer MAJOR #3): 채널 컨텍스트 메뉴 "읽음으로 표시" /
  // Unreads "읽음 처리" 가 쓰는 emit 경로 POST .../read-ack — 채널을 최신까지 읽음
  // 처리하고 read_state:updated 를 호출자 user 룸으로 fan-out 한다(멀티세션 동기화).
  it('read-ack reads the channel to latest AND fans read_state:updated (FR-RS-09 emit)', async () => {
    const ch = await createChannel();
    await postMessage(ch, 'r1');
    await postMessage(ch, 'r2');
    expect(await summaryUnread(ch)).toBe(2);

    const socket = await connect(member.accessToken);
    try {
      const events: Array<{ channelId: string; unreadCount: number }> = [];
      socket.on('read_state:updated', (e: { channelId: string; unreadCount: number }) =>
        events.push(e),
      );

      const res = await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${ch}/read-ack`)
        .set('origin', ORIGIN)
        .set(bearer(member.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.unreadCount).toBe(0);

      await new Promise((r) => setTimeout(r, 300));
      const forCh = events.find((e) => e.channelId === ch);
      // 종전 markRead(/read) 는 emit 안 함 → 멀티세션 desync. read-ack 는 emit.
      expect(forCh).toBeDefined();
      expect(forCh?.unreadCount).toBe(0);
      expect(await summaryUnread(ch)).toBe(0);
    } finally {
      socket.disconnect();
    }
  });
});
