/**
 * S47 (FR-MN-20): 배지 재동기화 컨트롤러 — debounce 500ms + inflight dedup.
 *
 * visibilitychange(hidden→visible) 와 Socket.IO reconnect 가 둘 다 짧은 간격으로
 * 발생할 수 있어, 그 트리거들을 단일 컨트롤러로 합쳐 **debounce 500ms** + **진행 중
 * 요청 dedup** 로 묶는다. **30초 polling 은 쓰지 않는다**(FR-MN-20 — 타이머 미등록).
 *
 * React/DOM 비의존 — 트리거(`request()`)와 fetch 주입(`fetcher`)만 받는다. 타이머는
 * 주입 가능한 setTimeout/clearTimeout 으로 테스트에서 vi.useFakeTimers 와 맞춘다.
 */
export interface BadgeResyncResult {
  workspaces: Array<{ workspaceId: string; mentionCount: number; unreadCount: number }>;
}

export interface BadgeResyncDeps {
  /** GET /me/notification-badges 를 호출하는 fetcher. */
  fetcher: () => Promise<BadgeResyncResult>;
  /** 결과를 badgeStore 에 반영(replaceAll). */
  onResult: (result: BadgeResyncResult) => void;
  /** debounce 윈도(ms). 기본 500. */
  debounceMs?: number;
  /** 테스트 주입용 타이머(기본 전역). */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

export class BadgeResyncController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private readonly debounceMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: BadgeResyncDeps) {
    this.debounceMs = deps.debounceMs ?? 500;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** 트리거(visibilitychange/reconnect). debounce 윈도 안의 연속 호출은 1회로 합친다. */
  request(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  /** 실제 fetch — 진행 중이면 dedup(중복 호출 금지). */
  private async run(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const result = await this.deps.fetcher();
      this.deps.onResult(result);
    } catch {
      // 재동기화 실패는 비-치명 — 다음 트리거(visibility/reconnect)가 재시도한다.
    } finally {
      this.inflight = false;
    }
  }

  /** 보류 중 타이머 정리(teardown). */
  dispose(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
