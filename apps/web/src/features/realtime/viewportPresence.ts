import {
  PRESENCE_VIEWPORT_DEBOUNCE_MS,
  PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK,
} from '@qufox/shared-types';

/**
 * S27 (FR-P15): split a userId list into presence:subscribe-sized chunks.
 * A single request never carries more than PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK
 * (100) ids; the gateway's own 500-cap is the hard ceiling, but we stay well
 * under it so a wide viewport doesn't trip the subscribe burst limiter.
 * Order is preserved and empty input yields no chunks.
 */
export function chunkUserIds(
  userIds: readonly string[],
  size: number = PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK,
): string[][] {
  const chunkSize = size > 0 ? size : PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK;
  const out: string[][] = [];
  for (let i = 0; i < userIds.length; i += chunkSize) {
    out.push(userIds.slice(i, i + chunkSize));
  }
  return out;
}

export interface ViewportPresenceCallbacks {
  /** Emit a presence:subscribe for one chunk (called once per chunk). */
  subscribe: (userIds: string[]) => void;
  /** Emit a presence:unsubscribe for the given ids (channel switch / blur). */
  unsubscribe: (userIds: string[]) => void;
}

export interface ViewportPresenceClock {
  /** Schedule `fn` after `ms`; returns a cancel token. Injectable for tests. */
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (token: ReturnType<typeof setTimeout>) => void;
}

const REAL_CLOCK: ViewportPresenceClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

/**
 * S27 (FR-P15): framework-agnostic core of the viewport presence subscription.
 *
 * The React hook (useViewportPresence) feeds it raw enter/leave signals from an
 * IntersectionObserver; this class owns the policy:
 *
 *   - DEBOUNCE: enter/leave events are coalesced over
 *     PRESENCE_VIEWPORT_DEBOUNCE_MS (200ms) so a fast scroll flushes one
 *     subscribe per settle, not one per row.
 *   - DIFF: on flush it subscribes ONLY the newly-visible ids (not already
 *     subscribed) and unsubscribes ids that left the viewport — never re-sends
 *     the whole set, keeping the gateway burst-limiter happy.
 *   - CHUNK: a subscribe batch larger than the chunk size is split into 100-id
 *     requests (chunkUserIds).
 *   - RESET: reset() (channel switch) is IMMEDIATE — it cancels any pending
 *     debounce, unsubscribes everything currently subscribed, and clears state.
 *     The hook calls this synchronously before disconnecting the observer.
 *
 * Pure + clock-injectable so the unit test drives it with fake timers and a
 * recording callbacks pair — no jsdom / real IntersectionObserver needed.
 */
export class ViewportPresenceTracker {
  private readonly visible = new Set<string>();
  private readonly subscribed = new Set<string>();
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cb: ViewportPresenceCallbacks,
    private readonly clock: ViewportPresenceClock = REAL_CLOCK,
    private readonly debounceMs: number = PRESENCE_VIEWPORT_DEBOUNCE_MS,
    private readonly chunkSize: number = PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK,
  ) {}

  /** A row/avatar for `userId` entered the viewport. */
  enter(userId: string): void {
    if (this.visible.has(userId)) return;
    this.visible.add(userId);
    this.scheduleFlush();
  }

  /** A row/avatar for `userId` left the viewport. */
  leave(userId: string): void {
    if (!this.visible.has(userId)) return;
    this.visible.delete(userId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.pendingTimer !== null) this.clock.clearTimeout(this.pendingTimer);
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Diff visible vs subscribed and emit subscribe/unsubscribe. */
  private flush(): void {
    const toSubscribe: string[] = [];
    for (const id of this.visible) {
      if (!this.subscribed.has(id)) toSubscribe.push(id);
    }
    const toUnsubscribe: string[] = [];
    for (const id of this.subscribed) {
      if (!this.visible.has(id)) toUnsubscribe.push(id);
    }

    if (toUnsubscribe.length > 0) {
      for (const id of toUnsubscribe) this.subscribed.delete(id);
      this.cb.unsubscribe(toUnsubscribe);
    }
    if (toSubscribe.length > 0) {
      for (const id of toSubscribe) this.subscribed.add(id);
      for (const chunk of chunkUserIds(toSubscribe, this.chunkSize)) {
        this.cb.subscribe(chunk);
      }
    }
  }

  /**
   * S27 (FR-P15): channel switch / teardown. Cancels any pending debounce,
   * unsubscribes everything currently subscribed (so the previous channel's
   * watched users stop fanning out), and clears all state. Synchronous —
   * callers disconnect the IntersectionObserver right after.
   */
  reset(): void {
    if (this.pendingTimer !== null) {
      this.clock.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const stale = [...this.subscribed];
    this.subscribed.clear();
    this.visible.clear();
    if (stale.length > 0) this.cb.unsubscribe(stale);
  }

  /** Test/diagnostic: the currently-subscribed ids (post-flush). */
  subscribedIds(): string[] {
    return [...this.subscribed];
  }
}
