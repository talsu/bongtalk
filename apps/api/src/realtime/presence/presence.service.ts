import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  PRESENCE_IDLE_TIMEOUT,
  PRESENCE_OFFLINE_GRACE,
  PRESENCE_SESSION_TTL_SEC,
  PRESENCE_SUB_TTL_SEC,
  maskPresenceForViewer,
  type PresenceStatus,
} from '@qufox/shared-types';
import { REDIS } from '../../redis/redis.module';

/**
 * S25 (FR-P01): 사용자 정적 선호값. Prisma `PresencePreference` 와 1:1.
 *   auto      — 연결 시 online, 미활동 시 idle, 끊김+grace 후 offline
 *   dnd       — Do Not Disturb(activity/idle 무관 유지)
 *   invisible — 본인에게만 실제값, 타인에게는 offline 으로 마스킹
 */
export type PresencePreference = 'auto' | 'dnd' | 'invisible';

/**
 * Presence is session-based — every WS connection is a session. A user is
 * "online" in a workspace iff at least one of their sessions has said so.
 *
 * Redis layout (prefix `qufox:` from RedisModule is applied by the client):
 *   presence:session:{sid}             HASH  userId/wsId/currentChannelId/connectedAt/lastSeenAt
 *                                      TTL   PRESENCE_SESSION_TTL_SEC
 *   presence:workspace:{wsId}:users    SET   of userId (cheap set-membership check)
 *   presence:user:{uid}:sessions       SET   of sid (so we can enumerate on kick)
 *   presence:user:{uid}:preference     STRING auto|dnd|invisible (STATIC setting —
 *                                      TTL ttlSec*2, re-driven from Prisma on connect;
 *                                      NEVER deleted by finalizeOffline — B1)
 *   presence:user:{uid}:graceEpoch     INT   bumped each register() so a cross-node
 *                                      reconnect aborts a stale OFFLINE finalize (B2)
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
    // S25 fix-forward(cheap + 가드): 단일 상수 기본값 + finite/>0 가드. 잘못 설정된
    // env 가 0/음수 TTL 로 세션을 즉시 만료시키지 않도록 한다.
    const raw = Number(process.env.PRESENCE_SESSION_TTL_SEC ?? PRESENCE_SESSION_TTL_SEC);
    return Number.isFinite(raw) && raw > 0 ? raw : PRESENCE_SESSION_TTL_SEC;
  }

  /**
   * S25 (FR-RT-10): 활성 연결 + 이 시간(초) 동안 활동 없음 → IDLE 자동전환.
   * env(PRESENCE_IDLE_TIMEOUT) override, 기본 600s(ADR-8 공유상수).
   */
  private get idleTimeoutSec(): number {
    return Number(process.env.PRESENCE_IDLE_TIMEOUT ?? PRESENCE_IDLE_TIMEOUT);
  }

  /**
   * S25 (FR-P02): 마지막 세션 끊김 후 OFFLINE 전환 grace(초). env override,
   * 기본 35s(ADR-8 공유상수). 게이트웨이가 이 값으로 grace 타이머를 건다.
   */
  get offlineGraceSec(): number {
    const raw = Number(process.env.PRESENCE_OFFLINE_GRACE ?? PRESENCE_OFFLINE_GRACE);
    return Number.isFinite(raw) && raw > 0 ? raw : PRESENCE_OFFLINE_GRACE;
  }

  async register(args: {
    sessionId: string;
    userId: string;
    workspaceIds: string[];
    // task-019-C / S25: 연결 시점 선호값. 'dnd' 는 dnd SET 에도 등록해
    // observer 가 dnd 닷을 렌더한다. 'invisible' 은 online/dnd SET 어디에도
    // 넣지 않아 마스킹 이전 단계에서부터 타 사용자에게 노출되지 않는다.
    preference?: PresencePreference;
  }): Promise<void> {
    const { sessionId, userId, workspaceIds, preference } = args;
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const pipe = this.redis.multi();
    pipe.hset(`presence:session:${sessionId}`, {
      userId,
      connectedAt: now,
      lastSeenAt: now,
    });
    pipe.expire(`presence:session:${sessionId}`, this.ttlSec);
    pipe.sadd(`presence:user:${userId}:sessions`, sessionId);
    pipe.expire(`presence:user:${userId}:sessions`, this.ttlSec * 2);
    // S25 (FR-RT-10): seed last-activity at connect so a freshly connected
    // user is ONLINE (not IDLE) until idleTimeout elapses without activity.
    pipe.set(`presence:user:${userId}:lastActivity`, String(nowMs), 'EX', this.ttlSec * 2);
    // S25 (FR-P01): persist preference so effectiveStatus can resolve
    // invisible/idle without a DB round-trip on every observer query.
    pipe.set(`presence:user:${userId}:preference`, preference ?? 'auto', 'EX', this.ttlSec * 2);
    // S25 fix-forward(B2 멀티노드 grace robustness): every (re)connect bumps a
    // monotonic grace epoch. The gateway captures this value when it arms the
    // OFFLINE grace timer; finalizeOffline aborts if the live epoch moved on
    // (i.e. a reconnect happened in the window) — even when that reconnect
    // landed on a DIFFERENT node, where the process-local timer cancel could
    // never have run. Shared via Redis so it's authoritative cross-node.
    pipe.incr(`presence:user:${userId}:graceEpoch`);
    pipe.expire(`presence:user:${userId}:graceEpoch`, this.ttlSec * 2);
    for (const wsId of workspaceIds) {
      // S25 (FR-P01): an invisible user joins NO observable SET — they are
      // online to themselves only. The dnd SET is membership for the dnd dot.
      if (preference === 'invisible') {
        pipe.srem(`presence:workspace:${wsId}:users`, userId);
        pipe.srem(`presence:workspace:${wsId}:dnd`, userId);
      } else if (preference === 'dnd') {
        pipe.sadd(`presence:workspace:${wsId}:users`, userId);
        pipe.sadd(`presence:workspace:${wsId}:dnd`, userId);
      } else {
        pipe.sadd(`presence:workspace:${wsId}:users`, userId);
        // If a previous session for this user was in dnd mode, clear
        // it on reconnect-with-auto so the two flavors don't ghost.
        pipe.srem(`presence:workspace:${wsId}:dnd`, userId);
      }
    }
    await pipe.exec();
  }

  /**
   * S25 (FR-RT-10): 클라이언트 `presence:activity` 수신 시 호출. last-activity 를
   * 현재 시각으로 갱신한다. 활성 세션이 있고 선호값이 dnd/invisible 이 아니면
   * IDLE→ONLINE 복귀를 의미한다(effectiveStatus 가 idleTimeout 미만이면 online).
   * 반환: 갱신 직전 idle 이었다가 이제 online 으로 바뀌는지(브로드캐스트 트리거용).
   */
  async touchActivity(userId: string): Promise<{ wasIdle: boolean }> {
    const beforeMs = await this.lastActivityMs(userId);
    const nowMs = Date.now();
    await this.redis.set(
      `presence:user:${userId}:lastActivity`,
      String(nowMs),
      'EX',
      this.ttlSec * 2,
    );
    const wasIdle = beforeMs !== null && nowMs - beforeMs >= this.idleTimeoutSec * 1000;
    return { wasIdle };
  }

  /** S25: last-activity epoch ms, or null if never seen / expired. */
  async lastActivityMs(userId: string): Promise<number | null> {
    const raw = await this.redis.get(`presence:user:${userId}:lastActivity`);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /** S25: read the persisted preference (auto if absent/expired). */
  async preferenceOf(userId: string): Promise<PresencePreference> {
    const raw = await this.redis.get(`presence:user:${userId}:preference`);
    if (raw === 'dnd' || raw === 'invisible') return raw;
    return 'auto';
  }

  /**
   * S25 fix-forward(B2): current grace epoch for a user (0 if never connected /
   * expired). Each register() INCRements it, so a captured value going stale by
   * the time the grace timer fires proves a reconnect happened — on ANY node.
   */
  async currentGraceEpoch(userId: string): Promise<number> {
    const raw = await this.redis.get(`presence:user:${userId}:graceEpoch`);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * S25 (FR-P01 + FR-RT-10 + FR-RT-11): compute the **true** effective status
   * for a user (no masking applied — caller masks per viewer).
   *
   *   - no active session  → offline
   *   - preference invisible → invisible (masked to offline for others)
   *   - preference dnd       → dnd (activity/idle 무관)
   *   - active + activity within idleTimeout → online
   *   - active + no activity for idleTimeout → idle
   *
   * Multi-device (FR-RT-11): "active" means scard(sessions) > 0, so any one
   * live session keeps the user out of offline.
   */
  async effectiveStatus(userId: string): Promise<PresenceStatus> {
    return (await this.effectiveStatusWithActivity(userId)).status;
  }

  /**
   * S25 fix-forward(perf MAJOR · N+1): like effectiveStatus but issues the
   * three Redis reads (session count / preference / last-activity) in a SINGLE
   * round-trip via Promise.all instead of 3 sequential awaits, and returns the
   * resolved lastActivityMs so callers (bulkFor) don't re-read it. ~1 RTT per
   * user instead of 2-3.
   */
  async effectiveStatusWithActivity(
    userId: string,
  ): Promise<{ status: PresenceStatus; lastActivityMs: number | null }> {
    const [sessions, preference, lastMs] = await Promise.all([
      this.redis.scard(`presence:user:${userId}:sessions`),
      this.preferenceOf(userId),
      this.lastActivityMs(userId),
    ]);
    if (sessions === 0) return { status: 'offline', lastActivityMs: lastMs };
    if (preference === 'invisible') return { status: 'invisible', lastActivityMs: lastMs };
    if (preference === 'dnd') return { status: 'dnd', lastActivityMs: lastMs };
    if (lastMs === null) return { status: 'online', lastActivityMs: null };
    const idle = Date.now() - lastMs >= this.idleTimeoutSec * 1000;
    return { status: idle ? 'idle' : 'online', lastActivityMs: lastMs };
  }

  /**
   * S25 (FR-RT-12): bulk presence for a set of users, masked for the viewer.
   * INVISIBLE → OFFLINE for everyone except the viewer themselves
   * (maskPresenceForViewer single point). Used by presence:subscribe/bulk and
   * any REST profile/member-list path that exposes presence.
   */
  async bulkFor(
    viewerUserId: string,
    userIds: string[],
  ): Promise<Array<{ userId: string; status: PresenceStatus; updatedAt: string }>> {
    const unique = [...new Set(userIds)];
    // S25 fix-forward(perf MAJOR · N+1): resolve every user concurrently and
    // reuse the lastActivityMs returned by effectiveStatusWithActivity instead
    // of a second per-user GET. Each user is ~1 RTT (3 reads pipelined via
    // Promise.all) and all users overlap, so a 500-user bulk is one fan-out
    // rather than 1000 sequential awaits.
    return Promise.all(
      unique.map(async (uid) => {
        const { status: real, lastActivityMs: lastMs } =
          await this.effectiveStatusWithActivity(uid);
        const status = maskPresenceForViewer(real, uid === viewerUserId);
        return {
          userId: uid,
          status,
          updatedAt: new Date(lastMs ?? Date.now()).toISOString(),
        };
      }),
    );
  }

  /**
   * task-019-C: flip every workspace this user is in to the new DnD
   * status. Mutates the `:dnd` SET membership so observers pick up
   * the change on the next `presence.updated` broadcast. Returns the
   * workspace ids that were touched (useful for fan-out).
   *
   * S25: thin wrapper over setPreferenceForUser so existing call sites
   * (PATCH /me/presence) keep working while the preference key stays in sync.
   */
  async setDndForUser(userId: string, workspaceIds: string[], isDnd: boolean): Promise<string[]> {
    return this.setPreferenceForUser(userId, workspaceIds, isDnd ? 'dnd' : 'auto');
  }

  /**
   * S25 (FR-P01): apply a new static preference (auto/dnd/invisible) to the
   * live Redis state of an online user across all their workspaces.
   *
   *   - auto      → present in online SET, absent from dnd SET, status resolves
   *                 to online/idle by activity
   *   - dnd       → present in both online + dnd SET
   *   - invisible → removed from both online + dnd SET (only self sees them)
   *
   * Also updates the persisted preference key so effectiveStatus resolves
   * correctly without waiting for a reconnect. Returns the touched workspaces.
   */
  async setPreferenceForUser(
    userId: string,
    workspaceIds: string[],
    preference: PresencePreference,
  ): Promise<string[]> {
    // Persist the preference even with no workspaces so DM/profile reads see it.
    await this.redis.set(`presence:user:${userId}:preference`, preference, 'EX', this.ttlSec * 2);
    if (workspaceIds.length === 0) return [];
    const online = await this.hasActiveSession(userId);
    const pipe = this.redis.multi();
    for (const wsId of workspaceIds) {
      if (preference === 'invisible') {
        pipe.srem(`presence:workspace:${wsId}:users`, userId);
        pipe.srem(`presence:workspace:${wsId}:dnd`, userId);
      } else if (preference === 'dnd') {
        if (online) pipe.sadd(`presence:workspace:${wsId}:users`, userId);
        pipe.sadd(`presence:workspace:${wsId}:dnd`, userId);
      } else {
        if (online) pipe.sadd(`presence:workspace:${wsId}:users`, userId);
        pipe.srem(`presence:workspace:${wsId}:dnd`, userId);
      }
    }
    await pipe.exec();
    return workspaceIds;
  }

  /**
   * S25 fix-forward(security HIGH · dndIn lazy GC): the DnD subset of a
   * workspace. Mirrors onlineIn's session-count lazy GC so a crashed session
   * whose TTL expired without the disconnect hook running can't leave a GHOST
   * dnd dot (raw smembers used to expose it). A user with zero live sessions is
   * SREMmed from the dnd SET and excluded from the result.
   */
  async dndIn(workspaceId: string): Promise<string[]> {
    const userIds = await this.redis.smembers(`presence:workspace:${workspaceId}:dnd`);
    if (userIds.length === 0) return [];
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
      await this.redis.srem(`presence:workspace:${workspaceId}:dnd`, ...toRemove);
    }
    return alive;
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
   * Called on WS disconnect. Removes the session hash + pops the sid from the
   * user's session SET (FR-RT-11: multi-device — one closed session does not
   * make a user offline if others remain).
   *
   * S25 (FR-P02): when the LAST session closes we DO NOT immediately drop the
   * user from the workspace SETs. We return `lastSessionGone: true` so the
   * gateway can arm a 35s grace timer; only when that timer fires without a
   * reconnect does `finalizeOffline` actually remove the user + broadcast
   * OFFLINE. A reconnect inside the window re-adds the session and the
   * gateway cancels the timer — no OFFLINE broadcast, previous state restored.
   */
  async unregister(args: {
    sessionId: string;
    userId: string;
    workspaceIds: string[];
  }): Promise<{ lastSessionGone: boolean }> {
    const { sessionId, userId } = args;
    const pipe = this.redis.multi();
    pipe.del(`presence:session:${sessionId}`);
    pipe.srem(`presence:user:${userId}:sessions`, sessionId);
    await pipe.exec();
    const remaining = await this.redis.scard(`presence:user:${userId}:sessions`);
    return { lastSessionGone: remaining === 0 };
  }

  /** S25: true iff the user currently has at least one live session. */
  async hasActiveSession(userId: string): Promise<boolean> {
    const remaining = await this.redis.scard(`presence:user:${userId}:sessions`);
    return remaining > 0;
  }

  /**
   * S25 (FR-P02): grace timer fired without a reconnect. Drop the user from
   * every workspace SET (online + dnd) and clear the live activity key so the
   * next `onlineIn` no longer lists them and observers see OFFLINE. Returns the
   * workspaces the caller should re-broadcast (empty if a reconnect happened in
   * the meantime).
   *
   * Two independent reconnect guards, BOTH cross-node:
   *
   *  1. scard(sessions) > 0 — the user has a live session again. This is the
   *     common-case defence and is authoritative across nodes because the
   *     session SET lives in shared Redis: a reconnect on ANOTHER node still
   *     re-adds a sid here, so this scard re-check sees it even though the
   *     process-local grace-timer cancel only ran on the node that armed it.
   *
   *  2. S25 fix-forward(B2): graceEpoch moved on. Even in the (tiny) window
   *     where a reconnect's register() has bumped the epoch but its session
   *     hasn't landed in scard yet, an epoch mismatch vs the value captured
   *     when the timer was armed proves a reconnect occurred → abort. Without
   *     this, a reconnect on a different node could be missed by the process-
   *     local timer entirely and the user would be wrongly finalized OFFLINE.
   *
   * S25 fix-forward(B1 · INVISIBLE leak): we DO NOT delete the preference key.
   * Preference is a STATIC user setting (auto/dnd/invisible); deleting it made
   * preferenceOf() fall back to 'auto', so an INVISIBLE user could be exposed
   * as online/idle on the next reconnect or by a lingering sibling session in
   * the grace window. The key carries its own TTL (ttlSec * 2) and is re-driven
   * from Prisma on the next connect — let that govern expiry. lastActivity is
   * still cleared (it IS live state).
   */
  async finalizeOffline(
    userId: string,
    workspaceIds: string[],
    armedGraceEpoch?: number,
  ): Promise<{ goneFrom: string[] }> {
    if (await this.hasActiveSession(userId)) return { goneFrom: [] };
    if (armedGraceEpoch !== undefined) {
      const live = await this.currentGraceEpoch(userId);
      if (live !== armedGraceEpoch) return { goneFrom: [] };
    }
    const rem = this.redis.multi();
    for (const wsId of workspaceIds) {
      rem.srem(`presence:workspace:${wsId}:users`, userId);
      rem.srem(`presence:workspace:${wsId}:dnd`, userId);
    }
    rem.del(`presence:user:${userId}:lastActivity`);
    // NOTE(B1): preference key intentionally NOT deleted — see method docstring.
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

  /**
   * S25 (FR-RT-10): the subset of `onlineIn(workspaceId)` whose effective
   * status is IDLE (active session + no activity for idleTimeout). DnD users
   * are excluded (DnD outranks idle). Returned so the workspace broadcast can
   * carry an `idleUserIds` set for the member-list dot. INVISIBLE users are
   * not in the workspace SET so they never appear here.
   */
  async idleIn(onlineUserIds: string[]): Promise<string[]> {
    if (onlineUserIds.length === 0) return [];
    // S25 fix-forward(perf MAJOR): resolve each user's status concurrently
    // (was a sequential await-loop). Order is preserved so the idle set is
    // deterministic for the sweep's change-detection key.
    const statuses = await Promise.all(onlineUserIds.map((uid) => this.effectiveStatus(uid)));
    return onlineUserIds.filter((_, i) => statuses[i] === 'idle');
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

  // ── S26 (FR-RT-12 / FR-P16): presence subscription lifecycle ───────────────
  //
  // Two complementary structures keep subscribe/fan-out cheap on BOTH sides:
  //   presence:sub:{socketId}         SET of subscribed userId — the forward
  //                                   index. Owned by the socket; TTL'd on
  //                                   disconnect (5m reconnect window), restored
  //                                   on reconnect if still present.
  //   presence:subscribers:{userId}   SET of socketId watching this user — the
  //                                   REVERSE index. Lets a presence change
  //                                   resolve its watchers in one SMEMBERS
  //                                   instead of scanning every sub:* key. Both
  //                                   are mutated together so they stay in sync.
  //
  // socketId is the routing key because Socket.IO's adapter forwards
  // `server.to(socketId)` to whichever node owns that socket — so a presence
  // change detected on node A reaches a subscriber socket on node B.

  private subKey(socketId: string): string {
    return `presence:sub:${socketId}`;
  }

  private subscribersKey(userId: string): string {
    return `presence:subscribers:${userId}`;
  }

  private get subTtlSec(): number {
    const raw = Number(process.env.PRESENCE_SUB_TTL_SEC ?? PRESENCE_SUB_TTL_SEC);
    return Number.isFinite(raw) && raw > 0 ? raw : PRESENCE_SUB_TTL_SEC;
  }

  /**
   * S26 (FR-RT-12): record that `socketId` now subscribes to each of `userIds`.
   * Adds to both the forward (sub:{socketId}) and reverse
   * (subscribers:{userId}) indexes. Persists the forward key with the session
   * TTL*2 so an idle socket's subscription survives a heartbeat lull but still
   * has an upper bound. Returns nothing — the caller emits the bulk snapshot.
   */
  async addSubscriptions(socketId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const pipe = this.redis.multi();
    pipe.sadd(this.subKey(socketId), ...userIds);
    // Keep the forward index alive at least as long as a live session.
    pipe.expire(this.subKey(socketId), this.ttlSec * 2);
    for (const uid of userIds) {
      pipe.sadd(this.subscribersKey(uid), socketId);
      pipe.expire(this.subscribersKey(uid), this.ttlSec * 2);
    }
    await pipe.exec();
  }

  /**
   * S26 (FR-P16): presence:unsubscribe — drop `userIds` from this socket's
   * forward index and remove the socket from each user's reverse index.
   */
  async removeSubscriptions(socketId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const pipe = this.redis.multi();
    pipe.srem(this.subKey(socketId), ...userIds);
    for (const uid of userIds) pipe.srem(this.subscribersKey(uid), socketId);
    await pipe.exec();
  }

  /** S26: the userIds a socket currently subscribes to. */
  async subscriptionsOf(socketId: string): Promise<string[]> {
    return this.redis.smembers(this.subKey(socketId));
  }

  /**
   * S26 (FR-P16): the socketIds currently subscribed to a user, with lazy GC —
   * a socketId whose forward key has expired (its 5m disconnect TTL elapsed) is
   * SREMmed from the reverse index so a presence change never fans out to a
   * dead subscriber. Returns the live subscriber socketIds.
   */
  async subscribersOf(userId: string): Promise<string[]> {
    const sockets = await this.redis.smembers(this.subscribersKey(userId));
    if (sockets.length === 0) return [];
    const pipe = this.redis.pipeline();
    for (const sid of sockets) pipe.exists(this.subKey(sid));
    const results = (await pipe.exec()) ?? [];
    const alive: string[] = [];
    const dead: string[] = [];
    results.forEach(([, ex], i) => {
      if (Number(ex ?? 0) > 0) alive.push(sockets[i]);
      else dead.push(sockets[i]);
    });
    if (dead.length > 0) await this.redis.srem(this.subscribersKey(userId), ...dead);
    return alive;
  }

  /**
   * S26 (FR-P16): on disconnect we DO NOT delete the forward index — we set a
   * 5-minute TTL so a reconnect inside the window can resume fan-out without
   * re-sending the whole subscribe list. The reverse index entries are GC-ed
   * lazily by subscribersOf once the forward key expires. Returns whether a
   * non-empty subscription existed (purely diagnostic).
   */
  async expireSubscriptions(socketId: string): Promise<{ hadSubscriptions: boolean }> {
    const exists = await this.redis.exists(this.subKey(socketId));
    if (!exists) return { hadSubscriptions: false };
    await this.redis.expire(this.subKey(socketId), this.subTtlSec);
    return { hadSubscriptions: true };
  }

  /**
   * S26 fix-forward(reviewer MAJOR-1): hard-clear a socket's forward index AND
   * its reverse-index footprint. Called on connect (NOT reconnect-restore): an
   * engine.io sid can be reused by a DIFFERENT user on a later connection, and a
   * lingering 5m-TTL forward index from the previous owner would otherwise
   * resurrect that owner's subscriptions for the new user. We read the stale
   * forward set first so we can SREM this socketId out of every reverse index it
   * still appears in, then DEL the forward key. A brand-new socketId is a no-op.
   *
   * Re-subscription after a reconnect is not lost: a reconnect is a NEW engine.io
   * sid, and the client resends presence:subscribe, so addSubscriptions rebuilds
   * the indexes cleanly. Retaining the old socketId-keyed set across reconnects
   * was never observable (different sid) — clearing it removes the cross-user
   * leak with no behavioural regression.
   */
  async clearSubscriptions(socketId: string): Promise<void> {
    const stale = await this.redis.smembers(this.subKey(socketId));
    const pipe = this.redis.multi();
    for (const uid of stale) pipe.srem(this.subscribersKey(uid), socketId);
    pipe.del(this.subKey(socketId));
    await pipe.exec();
  }
}
