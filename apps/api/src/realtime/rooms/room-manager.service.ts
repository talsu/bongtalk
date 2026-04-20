import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { rooms } from './room-names';

/**
 * Computes the set of rooms a newly-connected socket should join based on
 * the authenticated user's workspace memberships and (non-private) channels.
 * A single Prisma round-trip — no per-channel queries, so N+1 is structurally
 * impossible.
 */
@Injectable()
export class RoomManagerService {
  constructor(private readonly prisma: PrismaService) {}

  async roomsForUser(userId: string): Promise<{
    rooms: string[];
    workspaceIds: string[];
    channelIds: string[];
  }> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: {
        workspaceId: true,
        workspace: {
          select: {
            channels: {
              where: { deletedAt: null, isPrivate: false },
              select: { id: true },
            },
          },
        },
      },
    });

    const workspaceIds: string[] = [];
    const channelIds: string[] = [];
    const joined: string[] = [rooms.user(userId)];
    for (const m of memberships) {
      workspaceIds.push(m.workspaceId);
      joined.push(rooms.workspace(m.workspaceId));
      for (const c of m.workspace.channels) {
        channelIds.push(c.id);
        joined.push(rooms.channel(c.id));
      }
    }
    return { rooms: joined, workspaceIds, channelIds };
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
