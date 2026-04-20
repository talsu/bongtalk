import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';

/**
 * Task-018-F: typing indicator backing store.
 *
 * Redis layout (qufox: prefix applied by the client):
 *   typing:channel:{channelId}      SET   of userId currently typing
 *                                   TTL   TYPING_TTL_SEC (re-set on each ping)
 *   typing:throttle:{userId}:{chId} STR   presence key for per-user-per-channel
 *                                   TTL   TYPING_THROTTLE_SEC
 *
 * Design choices (see docs/tasks/018-ds-mockup-parity.md §Design Decisions):
 *   - At-most-once. Typing is ephemeral; a dropped ping just means the
 *     indicator flickers off slightly sooner. Outbox is over-provisioned.
 *   - Server-side throttle per (userId, channelId) via a short-lived
 *     string key — cheaper than rate-limit middleware, no shared state
 *     beyond Redis.
 *   - SET + 5 s TTL is the auto-GC: if a client disconnects without a
 *     stop-typing signal, their name drops from the indicator within
 *     one TTL window. Disconnect hook proactively removes too (below).
 */
@Injectable()
export class TypingService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private get ttlSec(): number {
    return Number(process.env.TYPING_TTL_SEC ?? 5);
  }

  private get throttleSec(): number {
    return Number(process.env.TYPING_THROTTLE_SEC ?? 3);
  }

  private channelKey(channelId: string): string {
    return `typing:channel:${channelId}`;
  }

  private throttleKey(userId: string, channelId: string): string {
    return `typing:throttle:${userId}:${channelId}`;
  }

  /**
   * Try to register (userId, channelId) as currently typing. Returns the
   * updated set on success, or `null` when the throttle is still active
   * (caller emits nothing in that case — the previous broadcast already
   * named this user).
   */
  async ping(userId: string, channelId: string): Promise<string[] | null> {
    const tk = this.throttleKey(userId, channelId);
    // SET NX with short TTL is the single-shot throttle. If the key
    // already exists (NX fails), we're inside the window.
    const throttleAck = await this.redis.set(tk, '1', 'EX', this.throttleSec, 'NX');
    if (throttleAck !== 'OK') return null;

    const sk = this.channelKey(channelId);
    const pipe = this.redis.multi();
    pipe.sadd(sk, userId);
    pipe.expire(sk, this.ttlSec);
    await pipe.exec();
    return this.redis.smembers(sk);
  }

  async currentlyTyping(channelId: string): Promise<string[]> {
    return this.redis.smembers(this.channelKey(channelId));
  }

  /**
   * task-021-R1-typing-stale-on-clear: client-originated stop signal
   * fired when the user empties their draft. Removes the user from the
   * typing set AND evicts the throttle key so a subsequent ping isn't
   * silently suppressed for up to 3s. Caller broadcasts the updated
   * set to the channel room.
   */
  async stop(userId: string, channelId: string): Promise<{ changed: boolean; members: string[] }> {
    const sk = this.channelKey(channelId);
    const tk = this.throttleKey(userId, channelId);
    const pipe = this.redis.multi();
    pipe.srem(sk, userId);
    pipe.del(tk);
    const res = (await pipe.exec()) ?? [];
    const sremCount = Number(res[0]?.[1] ?? 0);
    const members = await this.redis.smembers(sk);
    return { changed: sremCount > 0, members };
  }

  /**
   * Proactively drop a user from every channel set they may be in.
   * Used by the disconnect hook so the indicator clears faster than
   * the TTL would. `channelIds` comes from the socket state so we
   * don't need a reverse index.
   */
  async dropForUser(userId: string, channelIds: string[]): Promise<string[]> {
    if (channelIds.length === 0) return [];
    const pipe = this.redis.multi();
    for (const chId of channelIds) {
      pipe.srem(this.channelKey(chId), userId);
    }
    const results = (await pipe.exec()) ?? [];
    const changed: string[] = [];
    results.forEach(([, removed], i) => {
      if (Number(removed ?? 0) > 0) changed.push(channelIds[i]);
    });
    return changed;
  }
}
