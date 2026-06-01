import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { TYPING_TTL, TYPING_MAX_VISIBLE } from '@qufox/shared-types';
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
    // S26 (FR-P07): default unified on the shared TYPING_TTL constant (10s),
    // replacing the fragmented literal `?? 5`. The .env may still override, but
    // a missing/invalid env now falls back to the ADR-8 value, not 5. A
    // finite/>0 guard prevents a bad env from creating a 0-TTL SET that GCs
    // before a single indicator render.
    const raw = Number(process.env.TYPING_TTL_SEC ?? TYPING_TTL);
    return Number.isFinite(raw) && raw > 0 ? raw : TYPING_TTL;
  }

  private get throttleSec(): number {
    return Number(process.env.TYPING_THROTTLE_SEC ?? 3);
  }

  /**
   * S26 (FR-P07): how many typers the wire payload may name. The SET can hold
   * more (and TTL-GCs the rest), but the broadcast is capped so a busy channel
   * doesn't ship an unbounded id list — the client renders "외 N명". env
   * override with a finite/>=1 guard.
   */
  private get maxVisible(): number {
    const raw = Number(process.env.TYPING_MAX_VISIBLE ?? TYPING_MAX_VISIBLE);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : TYPING_MAX_VISIBLE;
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
    const members = await this.redis.smembers(sk);
    // S26 (FR-P07): cap the broadcast set. The just-pinged user is pinned to
    // the front so a busy channel never drops the typer that triggered this
    // emit; the remaining slots fill deterministically (sorted) so the wire is
    // stable across nodes.
    return this.capVisible(members, userId);
  }

  /**
   * S26 (FR-P07): the currently-typing set, capped to at most maxVisible ids.
   * `priorityUserId` (if any) is guaranteed a slot. The full set still lives in
   * Redis with its TTL — this only bounds what crosses the wire.
   */
  async currentlyTyping(channelId: string, priorityUserId?: string): Promise<string[]> {
    const members = await this.redis.smembers(this.channelKey(channelId));
    return this.capVisible(members, priorityUserId);
  }

  /** Deterministically cap an id list to maxVisible, pinning priorityUserId. */
  private capVisible(members: string[], priorityUserId?: string): string[] {
    if (members.length <= this.maxVisible) return members;
    const sorted = [...members].sort();
    if (priorityUserId && sorted.includes(priorityUserId)) {
      const rest = sorted.filter((id) => id !== priorityUserId);
      return [priorityUserId, ...rest].slice(0, this.maxVisible);
    }
    return sorted.slice(0, this.maxVisible);
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
    // S26 (FR-P07): the post-stop set is also capped for the wire.
    return { changed: sremCount > 0, members: this.capVisible(members) };
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
