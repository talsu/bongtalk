import { Injectable } from '@nestjs/common';
import { PRESENCE_UPDATE_THROTTLE_MS } from '@qufox/shared-types';

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
    // S25 fix-forward(cheap + NaN 가드): 단일 상수 기본값 + finite/>0 가드. 잘못
    // 설정된 env(NaN/음수)가 setTimeout 을 0 으로 만들어 폭주하지 않도록 한다.
    const raw = Number(process.env.PRESENCE_UPDATE_THROTTLE_MS ?? PRESENCE_UPDATE_THROTTLE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : PRESENCE_UPDATE_THROTTLE_MS;
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
