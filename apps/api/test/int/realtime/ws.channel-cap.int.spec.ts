import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_JOINED_CHANNELS } from '@qufox/shared-types';
import { RoomManagerService } from '../../../src/realtime/rooms/room-manager.service';
import { rooms } from '../../../src/realtime/rooms/room-names';
import { seedRtStack, setupRtIntEnv, type RtIntEnv } from './helpers';

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
});
