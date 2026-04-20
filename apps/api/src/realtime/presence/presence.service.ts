import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';

/**
 * Presence is session-based — every WS connection is a session. A user is
 * "online" in a workspace iff at least one of their sessions has said so.
 *
 * Redis layout (prefix `qufox:` from RedisModule is applied by the client):
 *   presence:session:{sid}             HASH  userId/wsId/currentChannelId/connectedAt/lastSeenAt
 *                                      TTL   PRESENCE_SESSION_TTL_SEC
 *   presence:workspace:{wsId}:users    SET   of userId (cheap set-membership check)
 *   presence:user:{uid}:sessions       SET   of sid (so we can enumerate on kick)
 *
 * The session TTL is the single GC: clients are expected to send
 * `presence:ping` every WS_HEARTBEAT_INTERVAL_MS (15s) so the 120s TTL rolls
 * forward. A missed 8 pings → session drops; workspace:users SET is cleaned
 * lazily by any subsequent `isUserOnline` → if every session hash is gone we
 * SREM the user.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private get ttlSec(): number {
    return Number(process.env.PRESENCE_SESSION_TTL_SEC ?? 120);
  }

  async register(args: {
    sessionId: string;
    userId: string;
    workspaceIds: string[];
    // task-019-C: DnD preference known at connect time. When 'dnd',
    // the user joins both the online SET (they are connected, after
    // all) and the DnD SET so observers can render the dnd dot.
    preference?: 'auto' | 'dnd';
  }): Promise<void> {
    const { sessionId, userId, workspaceIds, preference } = args;
    const now = new Date().toISOString();
    const pipe = this.redis.multi();
    pipe.hset(`presence:session:${sessionId}`, {
      userId,
      connectedAt: now,
      lastSeenAt: now,
    });
    pipe.expire(`presence:session:${sessionId}`, this.ttlSec);
    pipe.sadd(`presence:user:${userId}:sessions`, sessionId);
    pipe.expire(`presence:user:${userId}:sessions`, this.ttlSec * 2);
    for (const wsId of workspaceIds) {
      pipe.sadd(`presence:workspace:${wsId}:users`, userId);
      if (preference === 'dnd') {
        pipe.sadd(`presence:workspace:${wsId}:dnd`, userId);
      } else {
        // If a previous session for this user was in dnd mode, clear
        // it on reconnect-with-auto so the two flavors don't ghost.
        pipe.srem(`presence:workspace:${wsId}:dnd`, userId);
      }
    }
    await pipe.exec();
  }

  /**
   * task-019-C: flip every workspace this user is in to the new DnD
   * status. Mutates the `:dnd` SET membership so observers pick up
   * the change on the next `presence.updated` broadcast. Returns the
   * workspace ids that were touched (useful for fan-out).
   */
  async setDndForUser(userId: string, workspaceIds: string[], isDnd: boolean): Promise<string[]> {
    if (workspaceIds.length === 0) return [];
    const pipe = this.redis.multi();
    for (const wsId of workspaceIds) {
      if (isDnd) {
        pipe.sadd(`presence:workspace:${wsId}:dnd`, userId);
      } else {
        pipe.srem(`presence:workspace:${wsId}:dnd`, userId);
      }
    }
    await pipe.exec();
    return workspaceIds;
  }

  async dndIn(workspaceId: string): Promise<string[]> {
    return this.redis.smembers(`presence:workspace:${workspaceId}:dnd`);
  }

  async heartbeat(sessionId: string): Promise<boolean> {
    const exists = await this.redis.exists(`presence:session:${sessionId}`);
    if (!exists) return false;
    const now = new Date().toISOString();
    const pipe = this.redis.multi();
    pipe.hset(`presence:session:${sessionId}`, 'lastSeenAt', now);
    pipe.expire(`presence:session:${sessionId}`, this.ttlSec);
    await pipe.exec();
    return true;
  }

  async setCurrentChannel(sessionId: string, channelId: string | null): Promise<void> {
    if (channelId === null) {
      await this.redis.hdel(`presence:session:${sessionId}`, 'currentChannelId');
    } else {
      await this.redis.hset(`presence:session:${sessionId}`, 'currentChannelId', channelId);
    }
  }

  /**
   * Called on WS disconnect. Removes the session hash, pops the sid from the
   * user's session SET; if that was the last one, SREM the user from every
   * workspace SET they were in. Returns the set of workspaceIds the user is
   * now considered offline in (so the caller can emit `presence.updated`).
   */
  async unregister(args: {
    sessionId: string;
    userId: string;
    workspaceIds: string[];
  }): Promise<{ goneFrom: string[] }> {
    const { sessionId, userId, workspaceIds } = args;
    const pipe = this.redis.multi();
    pipe.del(`presence:session:${sessionId}`);
    pipe.srem(`presence:user:${userId}:sessions`, sessionId);
    const [,] = (await pipe.exec()) ?? [];
    const remaining = await this.redis.scard(`presence:user:${userId}:sessions`);
    if (remaining > 0) return { goneFrom: [] };
    // Last session gone — drop from every workspace set (online + dnd).
    const rem = this.redis.multi();
    for (const wsId of workspaceIds) {
      rem.srem(`presence:workspace:${wsId}:users`, userId);
      rem.srem(`presence:workspace:${wsId}:dnd`, userId);
    }
    await rem.exec();
    return { goneFrom: [...workspaceIds] };
  }

  async onlineIn(workspaceId: string): Promise<string[]> {
    const userIds = await this.redis.smembers(`presence:workspace:${workspaceId}:users`);
    if (userIds.length === 0) return [];
    // Lazy GC — drop users whose session SET is empty (TTL expired without
    // disconnect hook running, e.g. API crash).
    const pipe = this.redis.pipeline();
    for (const uid of userIds) pipe.scard(`presence:user:${uid}:sessions`);
    const results = (await pipe.exec()) ?? [];
    const alive: string[] = [];
    const toRemove: string[] = [];
    results.forEach(([, count], i) => {
      const n = Number(count ?? 0);
      if (n > 0) alive.push(userIds[i]);
      else toRemove.push(userIds[i]);
    });
    if (toRemove.length > 0) {
      await this.redis.srem(`presence:workspace:${workspaceId}:users`, ...toRemove);
    }
    return alive;
  }

  async forceKickSessions(userId: string): Promise<string[]> {
    const sids = await this.redis.smembers(`presence:user:${userId}:sessions`);
    if (sids.length === 0) return [];
    const pipe = this.redis.multi();
    for (const s of sids) pipe.del(`presence:session:${s}`);
    pipe.del(`presence:user:${userId}:sessions`);
    await pipe.exec();
    return sids;
  }
}
