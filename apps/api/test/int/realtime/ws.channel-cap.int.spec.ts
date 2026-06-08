import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { MAX_JOINED_CHANNELS } from '@qufox/shared-types';
import { RoomManagerService } from '../../../src/realtime/rooms/room-manager.service';
import { RealtimeGateway } from '../../../src/realtime/realtime.gateway';
import { rooms } from '../../../src/realtime/rooms/room-names';
import { connectReady, seedRtStack, setupRtIntEnv, type RtIntEnv } from './helpers';

/**
 * FR-RT-02 — per-user joined-channel cap.
 *
 * The gateway uses an EAGER-join model: on connect RoomManager.roomsForUser
 * joins the user room + every workspace room + every viewable channel room.
 * FR-RT-02 caps the *channel* rooms at MAX_JOINED_CHANNELS (newest-first);
 * the user + workspace rooms are never capped. This is the eager-join
 * interpretation of "force-leave oldest" — overflow channels are simply not
 * joined (the client backfills via the user room's unread events + REST),
 * which differs from a dynamic LRU eviction model.
 *
 * Channels are inserted directly via Prisma (not the REST endpoint) so the
 * fixture stays cheap and avoids the channels.service position-spacing math,
 * which is out of this slice's scope.
 */
let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;
let roomMgr: RoomManagerService;

const EXTRA_CHANNELS = 60; // seed already makes 1 → 61 viewable total, > cap of 50

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
  roomMgr = env.app.get(RoomManagerService);

  // Insert EXTRA_CHANNELS public TEXT channels with deterministic,
  // increasing createdAt so newest-first ordering is unambiguous. The
  // owner is already a workspace member, so every public channel is
  // viewable to them.
  const base = Date.UTC(2025, 0, 1, 0, 0, 0);
  for (let i = 0; i < EXTRA_CHANNELS; i++) {
    await env.prisma.channel.create({
      data: {
        workspaceId: stack.workspaceId,
        name: `cap-${i}`,
        type: 'TEXT',
        position: i + 1,
        isPrivate: false,
        // 1s apart, all newer than the seed channel created "now-ish" only
        // if seed is older; we instead assert against the actual DB order
        // below rather than assuming seed's relative age.
        createdAt: new Date(base + i * 1000),
      },
    });
  }
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe('FR-RT-02 channel join cap (eager-join interpretation)', () => {
  it('joins user + workspace rooms always, and exactly MAX_JOINED_CHANNELS channel rooms', async () => {
    const {
      rooms: joined,
      channelIds,
      workspaceIds,
    } = await roomMgr.roomsForUser(stack.owner.userId);

    // user room present
    expect(joined).toContain(rooms.user(stack.owner.userId));
    // every workspace room present (NOT capped)
    for (const wsId of workspaceIds) {
      expect(joined).toContain(rooms.workspace(wsId));
    }

    // channel rooms capped at the constant
    expect(channelIds.length).toBe(MAX_JOINED_CHANNELS);
    const channelRoomCount = joined.filter((r) => r.startsWith('channel:')).length;
    expect(channelRoomCount).toBe(MAX_JOINED_CHANNELS);

    // total rooms = user(1) + workspaces + capped channels
    expect(joined.length).toBe(1 + workspaceIds.length + MAX_JOINED_CHANNELS);
  });

  it('admits the NEWEST channels (createdAt desc) under the cap', async () => {
    const { channelIds } = await roomMgr.roomsForUser(stack.owner.userId);

    // The full viewable set, ordered exactly like the cap (createdAt desc,
    // id desc). The admitted set must equal the top MAX_JOINED_CHANNELS.
    const allViewable = await env.prisma.channel.findMany({
      where: { workspaceId: stack.workspaceId, deletedAt: null, isPrivate: false },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const expectedNewest = new Set(allViewable.slice(0, MAX_JOINED_CHANNELS).map((c) => c.id));
    expect(channelIds.length).toBe(expectedNewest.size);
    for (const id of channelIds) {
      expect(expectedNewest.has(id)).toBe(true);
    }
  });

  // review MAJOR-2: a DM / USER-override channel must survive the cap ahead of
  // ordinary public channels. Here the DM is the OLDEST channel (createdAt 2024)
  // so a pure createdAt-desc ranking would evict it below the 50 line; the
  // priority sort must still admit it (DMs have no "open + REST backfill"
  // affordance, so silent realtime loss would be a real defect).
  it('admits an old DM/override channel within the cap (priority over public)', async () => {
    const dm = await env.prisma.channel.create({
      data: {
        workspaceId: stack.workspaceId,
        name: `dm-old-${Date.now().toString(36)}`,
        type: 'DIRECT',
        position: 9999,
        isPrivate: true,
        // older than every public cap channel (2025-…) → last by createdAt.
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)),
      },
    });
    await env.prisma.channelPermissionOverride.create({
      data: {
        channelId: dm.id,
        principalType: 'USER',
        principalId: stack.owner.userId,
        allowMask: 1, // any non-zero ALLOW admits the channel (roomsForUser: gt 0)
        denyMask: 0,
      },
    });

    const { channelIds } = await roomMgr.roomsForUser(stack.owner.userId);
    // cap is still respected …
    expect(channelIds.length).toBe(MAX_JOINED_CHANNELS);
    // … and the old DM is admitted despite being the oldest channel.
    expect(channelIds).toContain(dm.id);
  });

  // S99 (S07 carryover · LOW): refreshUserChannelIds 의 leave 대칭.
  // 새 채널이 생겨 cap 밖으로 밀린(admitted 였다가 빠진) 채널은 refresh 시 실제로
  // 룸에서 leave 돼야 한다(종전엔 toJoin 만 처리해 소켓이 유령 구독으로 남았다).
  it('refreshUserChannelIds leaves channels pushed out of the cap (join/leave symmetry)', async () => {
    const gateway = env.app.get(RealtimeGateway);
    // 현재 admitted 집합(가장 오래된 admitted 채널 = 다음 신규 생성으로 밀려날 후보).
    const before = await roomMgr.roomsForUser(stack.owner.userId);
    expect(before.channelIds.length).toBe(MAX_JOINED_CHANNELS);

    let socket: Socket | null = null;
    try {
      socket = await connectReady(env.wsUrl, stack.owner.accessToken);
      // connect 시 게이트웨이가 admitted 채널 룸에 join 한 상태. 가장 오래된
      // admitted 채널(곧 밀려날 대상)을 고른다(createdAt asc 의 첫 admitted).
      // ※ DM/override 채널은 roomsForUser 에서 priority 로 cap 위에 고정돼 절대
      //   evict 되지 않으므로(직전 테스트가 2024 DM 을 남김) 비-priority 공개
      //   채널(isPrivate:false)만 후보로 삼아야 실제로 밀려나는 채널을 고른다.
      const admittedAsc = await env.prisma.channel.findMany({
        where: { id: { in: before.channelIds }, isPrivate: false },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const evictionCandidate = admittedAsc[0]!.id;

      // 더 새로운 공개 채널을 생성 → 새 admitted, 가장 오래된 admitted 가 cap 밖으로.
      const fresh = await env.prisma.channel.create({
        data: {
          workspaceId: stack.workspaceId,
          name: `cap-fresh-${Date.now().toString(36)}`,
          type: 'TEXT',
          position: 99999,
          isPrivate: false,
          createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0)),
        },
      });

      const after = await roomMgr.roomsForUser(stack.owner.userId);
      // fresh 는 admitted, evictionCandidate 는 더 이상 admitted 아님.
      expect(after.channelIds).toContain(fresh.id);
      expect(after.channelIds).not.toContain(evictionCandidate);

      // refresh 후 소켓은 fresh 룸에 join, evictionCandidate 룸에서 leave 돼야 한다.
      await gateway.refreshUserChannelIds(stack.owner.userId);

      const inFresh = await gateway.server.in(rooms.channel(fresh.id)).fetchSockets();
      const inEvicted = await gateway.server.in(rooms.channel(evictionCandidate)).fetchSockets();
      const sids = (arr: { id: string }[]) => arr.map((s) => s.id);
      expect(sids(inFresh)).toContain(socket.id);
      // 핵심 회귀: 밀려난 채널 룸에서 실제로 leave 됐다(유령 구독 없음).
      expect(sids(inEvicted)).not.toContain(socket.id);
    } finally {
      socket?.disconnect();
    }
  });
});
