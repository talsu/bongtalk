import { Injectable } from '@nestjs/common';

/**
 * task-046 iter0 (MED-1 carry-over): Coalesce user.profile.updated broadcasts
 * when a single user toggles customStatus rapidly. PresenceThrottler 와
 * 패턴 동일 — first call 이 deadline 결정, 이후 호출은 drop.
 *
 * 60/min × N workspaces fanout 의 spam 위험을
 * `STATUS_BROADCAST_THROTTLE_MS` (default 5000ms) 로 단일 broadcast 보장.
 */
@Injectable()
export class StatusBroadcastThrottler {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  private get windowMs(): number {
    return Number(process.env.STATUS_BROADCAST_THROTTLE_MS ?? 5000);
  }

  schedule(userId: string, flush: () => Promise<void> | void): void {
    if (this.pending.has(userId)) return;
    const t = setTimeout(() => {
      this.pending.delete(userId);
      try {
        void Promise.resolve(flush()).catch(() => undefined);
      } catch {
        /* noop */
      }
    }, this.windowMs);
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
      (t as unknown as { unref: () => void }).unref();
    }
    this.pending.set(userId, t);
  }

  cancel(userId?: string): void {
    if (userId) {
      const t = this.pending.get(userId);
      if (t) clearTimeout(t);
      this.pending.delete(userId);
      return;
    }
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
