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
 * S11 (FR-RT-13/14/19) integration spec.
 *
 *  - POST /workspaces/:id/channels/:chid/ack : monotonic (createdAt, id)
 *    tuple upsert. An out-of-order (older) ack must NOT regress the cursor.
 *  - unread tuple accuracy: advancing ack shrinks unread.
 *  - read_state:updated emit to the user's private room on ack.
 *  - 404 when lastReadMessageId does not belong to the channel.
 *
 * One workspace is seeded ONCE in beforeAll (the helper's slug derives from
 * the clock, so seeding under frozen time per-test collides). Each test
 * creates its own freshly-named channel so cursors don't bleed across tests.
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
    .send({ name: `ack-ch-${chSeq}`, type: 'TEXT' });
  if (res.status !== 201) throw new Error(`channel create failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

async function postMessage(channelId: string, token: string, content: string): Promise<string> {
  const res = await request(env.baseUrl)
    .post(`/workspaces/${workspaceId}/channels/${channelId}/messages`)
    .set('origin', ORIGIN)
    .set(bearer(token))
    .send({ content });
  if (res.status !== 201) throw new Error(`message post failed: ${res.status} ${res.text}`);
  return res.body.message.id as string;
}

function unreadFromSummary(
  channels: Array<{ channelId: string; unreadCount: number }>,
  id: string,
) {
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

function waitFor<T>(socket: Socket, ev: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(ev, on);
      reject(new Error(`timeout waiting for ${ev}`));
    }, timeoutMs);
    function on(arg: T): void {
      clearTimeout(t);
      socket.off(ev, on);
      resolve(arg);
    }
    socket.on(ev, on);
  });
}

describe('S11 ack read-sync (FR-RT-13/14/19)', () => {
  it('monotonic upsert: an older ack does NOT regress the cursor (퇴행 무시)', async () => {
    const channelId = await createChannel();
    const m1 = await postMessage(channelId, owner.accessToken, 'm1');
    const m2 = await postMessage(channelId, owner.accessToken, 'm2');
    const m3 = await postMessage(channelId, owner.accessToken, 'm3');

    // Ack the newest (m3) ⇒ 0 unread.
    const ack3 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m3 });
    expect(ack3.status).toBe(200);
    expect(ack3.body.unreadCount).toBe(0);
    expect(ack3.body.lastReadMessageId).toBe(m3);

    // Now ack an OLDER message (m1). The cursor must stay at m3 (no regress).
    const ack1 = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m1 });
    expect(ack1.status).toBe(200);
    expect(ack1.body.unreadCount).toBe(0);
    expect(ack1.body.lastReadMessageId).toBe(m3);

    const sum = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(unreadFromSummary(sum.body.channels, channelId)).toBe(0);
    void m2;
  });

  it('advancing ack moves the cursor forward and shrinks unread', async () => {
    const channelId = await createChannel();
    const m1 = await postMessage(channelId, owner.accessToken, 'a1');
    await postMessage(channelId, owner.accessToken, 'a2');
    await postMessage(channelId, owner.accessToken, 'a3');

    // No cursor yet ⇒ all 3 unread.
    const sum0 = await request(env.baseUrl)
      .get(`/workspaces/${workspaceId}/unread-summary`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken));
    expect(unreadFromSummary(sum0.body.channels, channelId)).toBe(3);

    // Ack the oldest (a1) ⇒ 2 remain.
    const ack = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: m1 });
    expect(ack.status).toBe(200);
    expect(ack.body.unreadCount).toBe(2);
  });

  it('rejects a lastReadMessageId that does not belong to the channel (404)', async () => {
    const chA = await createChannel();
    const chB = await createChannel();
    const inB = await postMessage(chB, owner.accessToken, 'lives-in-b');

    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${chA}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ lastReadMessageId: inB });
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('MESSAGE_NOT_FOUND');
  });

  it('rejects a malformed body (no lastReadMessageId)', async () => {
    const channelId = await createChannel();
    const res = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/channels/${channelId}/ack`)
      .set('origin', ORIGIN)
      .set(bearer(member.accessToken))
      .send({ clientTimestamp: 1 });
    expect(res.status).toBe(400);
  });

  it('emits read_state:updated to the caller user room on ack', async () => {
    const channelId = await createChannel();
    const m1 = await postMessage(channelId, owner.accessToken, 'e1');
    await postMessage(channelId, owner.accessToken, 'e2');

    // member connects on a second "device" (socket) and listens on its own
    // user room. The ack HTTP call should fan read_state:updated to that
    // socket so other tabs/devices sync the badge.
    const socket = await connect(member.accessToken);
    try {
      const received = waitFor<{
        channelId: string;
        lastReadMessageId: string | null;
        unreadCount: number;
      }>(socket, 'read_state:updated', 5000);

      const ack = await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${channelId}/ack`)
        .set('origin', ORIGIN)
        .set(bearer(member.accessToken))
        .send({ lastReadMessageId: m1 });
      expect(ack.status).toBe(200);

      const ev = await received;
      expect(ev.channelId).toBe(channelId);
      expect(ev.lastReadMessageId).toBe(m1);
      expect(ev.unreadCount).toBe(1); // e2 still unread
    } finally {
      socket.disconnect();
    }
  });
});
