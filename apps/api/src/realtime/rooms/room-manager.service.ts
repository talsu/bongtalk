import { Injectable, Logger } from '@nestjs/common';
import { MAX_JOINED_CHANNELS } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { rooms } from './room-names';

/**
 * Computes the set of rooms a newly-connected socket should join based on
 * the authenticated user's workspace memberships and (non-private) channels.
 * A single Prisma round-trip per source — no per-channel queries, so N+1 is
 * structurally impossible.
 *
 * FR-RT-02 — per-user channel-join cap (eager-join interpretation):
 *   The user room + every workspace room are ALWAYS joined and never capped.
 *   Channel rooms are sorted newest-first (createdAt desc, id desc as a
 *   stable tiebreaker) and only the top MAX_JOINED_CHANNELS are joined.
 *   Overflow channels are simply NOT joined on connect — this is the
 *   eager-join reading of "force-leave the oldest channel": rather than a
 *   dynamic LRU eviction at runtime, we deterministically admit the newest
 *   N at join time. The client backfills overflow channels via the user
 *   room's unread events + REST history. Keeping the eager model intact
 *   avoids the on-demand-join rewrite the gateway was explicitly built to
 *   avoid.
 */
@Injectable()
export class RoomManagerService {
  private readonly logger = new Logger(RoomManagerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async roomsForUser(userId: string): Promise<{
    rooms: string[];
    workspaceIds: string[];
    channelIds: string[];
    // S70 fix-forward (perf MODERATE): 이 사용자가 임시 멤버(isTemporary)인 워크스페이스 id.
    // 멤버십 단일 쿼리에서 함께 추려 connect hot-path 의 별도 쿼리(loadTemporaryWorkspaceIds)
    // 를 제거한다. 임시 멤버가 없으면 빈 배열 → connect/disconnect 강퇴 추적이 no-op.
    temporaryWorkspaceIds: string[];
  }> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: {
        workspaceId: true,
        // S70 (FR-W12): 임시 멤버십 플래그 — connect 시 강퇴 추적 대상 워크스페이스 도출용.
        isTemporary: true,
        workspace: {
          select: {
            channels: {
              where: { deletedAt: null, isPrivate: false },
              select: { id: true, createdAt: true },
            },
          },
        },
      },
    });

    // 033/034 DM follow-up: private channels (incl. workspace-less
    // DIRECT) are admitted via USER-level ALLOW overrides, not
    // workspace membership. Fetch every channel the user has a
    // non-zero allowMask on so inbound DM events reach the socket.
    const overrideChannels = await this.prisma.channelPermissionOverride.findMany({
      where: {
        principalType: 'USER',
        principalId: userId,
        allowMask: { gt: 0 },
        channel: { deletedAt: null },
      },
      select: { channel: { select: { id: true, createdAt: true } } },
    });

    const workspaceIds: string[] = [];
    const temporaryWorkspaceIds: string[] = [];
    const joined: string[] = [rooms.user(userId)];

    // Gather the full viewable channel set (workspace + override) deduped,
    // each carrying createdAt so we can rank before capping. `priority` marks
    // USER-override channels (DMs / private), which must survive the cap ahead
    // of ordinary public channels — review MAJOR-2: an old DM ranked purely by
    // createdAt could be evicted below the cap line and silently lose realtime
    // delivery (no "open channel + REST backfill" affordance for DMs).
    const seenChannels = new Set<string>();
    const candidateChannels: Array<{ id: string; createdAt: Date; priority: boolean }> = [];
    for (const m of memberships) {
      workspaceIds.push(m.workspaceId);
      if (m.isTemporary) temporaryWorkspaceIds.push(m.workspaceId);
      joined.push(rooms.workspace(m.workspaceId));
      for (const c of m.workspace.channels) {
        if (seenChannels.has(c.id)) continue;
        seenChannels.add(c.id);
        candidateChannels.push({ ...c, priority: false });
      }
    }
    for (const o of overrideChannels) {
      const c = o.channel;
      if (seenChannels.has(c.id)) continue;
      seenChannels.add(c.id);
      candidateChannels.push({ ...c, priority: true });
    }

    // Priority(DM/override) first, then newest-first, then id desc as a stable
    // deterministic tiebreaker for channels created in the same millisecond.
    // DMs sort ahead of public channels so they are admitted within the 50-cap
    // before any public channel is dropped.
    candidateChannels.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      return t !== 0 ? t : b.id.localeCompare(a.id);
    });

    const total = candidateChannels.length;
    const admitted = candidateChannels.slice(0, MAX_JOINED_CHANNELS);
    const channelIds: string[] = [];
    for (const c of admitted) {
      channelIds.push(c.id);
      joined.push(rooms.channel(c.id));
    }

    if (total > MAX_JOINED_CHANNELS) {
      this.logger.warn(
        `[rooms] channel join cap hit user=${userId} viewable=${total} ` +
          `joined=${channelIds.length} dropped=${total - channelIds.length} ` +
          `(cap=${MAX_JOINED_CHANNELS}); overflow channels backfill via user room + REST`,
      );
    }

    return { rooms: joined, workspaceIds, channelIds, temporaryWorkspaceIds };
  }

  /**
   * Returns true iff the given user is still a member of the workspace.
   * Used at connect time + when a member-left event arrives to decide
   * whether to proactively kick the socket.
   */
  async isMember(userId: string, workspaceId: string): Promise<boolean> {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    return m !== null;
  }
}
