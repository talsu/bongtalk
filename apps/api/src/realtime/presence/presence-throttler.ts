import { Injectable } from '@nestjs/common';

/**
 * Coalesce presence.updated broadcasts so an event storm (e.g. 100 users
 * disconnect at once) doesn't fire 100 broadcasts. One broadcast per
 * workspace per `PRESENCE_UPDATE_THROTTLE_MS` window.
 *
 * Each workspace keyframe remembers the pending dispatch deadline; subsequent
 * schedule() calls inside the window extend nothing — the first schedule
 * decides when the flush fires.
 */
@Injectable()
export class PresenceThrottler {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  private get windowMs(): number {
    return Number(process.env.PRESENCE_UPDATE_THROTTLE_MS ?? 2000);
  }

  schedule(workspaceId: string, flush: () => Promise<void>): void {
    if (this.pending.has(workspaceId)) return;
    const t = setTimeout(() => {
      this.pending.delete(workspaceId);
      void flush().catch(() => undefined);
    }, this.windowMs);
    // Don't keep Node alive just for a throttler.
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
      (t as unknown as { unref: () => void }).unref();
    }
    this.pending.set(workspaceId, t);
  }

  cancel(workspaceId?: string): void {
    if (workspaceId) {
      const t = this.pending.get(workspaceId);
      if (t) clearTimeout(t);
      this.pending.delete(workspaceId);
      return;
    }
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
