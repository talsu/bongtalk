import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * S25 (FR-P02): per-user OFFLINE grace timers.
 *
 * When a user's LAST WS session closes the gateway arms a timer here for
 * PRESENCE_OFFLINE_GRACE seconds (default 35). If the user reconnects inside
 * the window the gateway calls cancel() and no OFFLINE broadcast ever fires —
 * the previous status is restored instantly. If the window elapses the timer
 * fires and the gateway finalizes OFFLINE + broadcasts.
 *
 * This is process-local: grace is about a momentary network blip / page
 * navigation, so a timer on the node that saw the disconnect is sufficient.
 * The Redis session SET (with its own TTL) is the cross-node safety net for
 * a node crash mid-grace.
 *
 * Mirrors PresenceThrottler's unref() discipline so a pending timer never
 * keeps the Node process alive on shutdown.
 */
@Injectable()
export class PresenceGraceTimers implements OnModuleDestroy {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  /**
   * Arm a grace timer for a user. Re-arming (e.g. a second device's
   * disconnect) replaces the existing timer so the fire is always
   * `delayMs` after the most recent last-session-gone event.
   */
  arm(userId: string, delayMs: number, onElapsed: () => Promise<void>): void {
    this.cancel(userId);
    const t = setTimeout(() => {
      this.pending.delete(userId);
      void onElapsed().catch(() => undefined);
    }, delayMs);
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
      (t as unknown as { unref: () => void }).unref();
    }
    this.pending.set(userId, t);
  }

  /** Cancel a pending grace timer (reconnect inside the window). */
  cancel(userId: string): boolean {
    const t = this.pending.get(userId);
    if (!t) return false;
    clearTimeout(t);
    this.pending.delete(userId);
    return true;
  }

  has(userId: string): boolean {
    return this.pending.has(userId);
  }

  onModuleDestroy(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
