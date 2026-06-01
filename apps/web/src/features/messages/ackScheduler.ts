/**
 * S22 (FR-RS-02): 스크롤 디바운스 ACK + 즉시 ACK 스케줄러.
 *
 * 정책:
 *  - 일반 스크롤로 새 메시지를 지나치면 **5초 디바운스** 후 ACK 를 한 번 보낸다
 *    (rapid 스크롤이 ack 폭주를 일으키지 않도록).
 *  - **scroll-to-bottom** 상태에서 새 메시지를 수신하면 디바운스 없이 **즉시 ACK**.
 *  - 같은 lastReadMessageId 에 대한 중복 flush 는 생략(서버는 monotonic 이라
 *    안전하지만 불필요한 RTT 를 줄인다).
 *  - flush 시 호출부가 ACK body 에 실을 수 있도록 `clientTimestamp`(ISO) 를 함께
 *    넘긴다.
 *
 * 타이머/시계 의존이라 vi.useFakeTimers + vi.setSystemTime 으로 단위 검증한다.
 * 외부 모킹 라이브러리 없이 flush 콜백만 주입한다.
 */

export interface AckFlush {
  channelId: string;
  lastReadMessageId: string;
  /**
   * flush 시점의 epoch millis. ACK body 의 `clientTimestamp` 로 전달된다.
   * 서버 contract(AckReadRequestSchema)가 number(epoch millis)를 받으므로
   * ISO 문자열이 아니라 숫자로 싣는다.
   */
  clientTimestamp: number;
}

export interface AckSchedulerOptions {
  /** 디바운스 윈도우(ms). 기본 5000 (FR-RS-02). */
  debounceMs?: number;
  /** 실제 ACK 전송. 순수 검증을 위해 주입한다. */
  onFlush: (flush: AckFlush) => void;
  /** 시계 주입(테스트용). 기본 Date.now. */
  now?: () => number;
}

/** scroll-to-bottom 판정 임계치(px). 가상화 미사용 컨테이너용 기본 seam. */
export const SCROLL_BOTTOM_THRESHOLD_PX = 50;

/**
 * 컨테이너 스크롤 위치가 바닥(또는 임계 내)인지 판정한다. 가상화 리스트는
 * 마지막 virtualIndex 의 messageId 로 따로 판정하므로(FR-RS-02), 이 헬퍼는
 * 일반 스크롤 컨테이너용 seam 이다.
 */
export function isScrolledToBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx: number = SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  return scrollTop >= scrollHeight - clientHeight - thresholdPx;
}

export class AckScheduler {
  private readonly debounceMs: number;
  private readonly onFlush: (flush: AckFlush) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingChannelId: string | null = null;
  private pendingMessageId: string | null = null;
  /** 마지막으로 flush 한 (channelId, messageId) — 중복 flush 차단용. */
  private lastFlushedChannelId: string | null = null;
  private lastFlushedMessageId: string | null = null;

  constructor(opts: AckSchedulerOptions) {
    this.debounceMs = opts.debounceMs ?? 5000;
    this.onFlush = opts.onFlush;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 스크롤로 새 메시지를 지나친 경우. 5초 디바운스 후 ACK. 디바운스 윈도우 안에
   * 다시 호출되면 타이머를 갱신(마지막 messageId 로) 한다.
   */
  scheduleDebounced(channelId: string, lastReadMessageId: string): void {
    this.pendingChannelId = channelId;
    this.pendingMessageId = lastReadMessageId;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
    }, this.debounceMs);
  }

  /**
   * scroll-to-bottom 에서 새 메시지를 받은 경우. 디바운스 없이 즉시 ACK 하고
   * 대기 중 디바운스 타이머가 있으면 취소한다.
   */
  flushImmediate(channelId: string, lastReadMessageId: string): void {
    this.cancel();
    this.pendingChannelId = channelId;
    this.pendingMessageId = lastReadMessageId;
    this.flushPending();
  }

  /** 대기 중 디바운스를 강제 flush(언마운트/채널 전환 직전 등). */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushPending();
  }

  /** 대기 타이머 + 대기 중인 ACK 를 취소(전송 없이). */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingChannelId = null;
    this.pendingMessageId = null;
  }

  private flushPending(): void {
    const channelId = this.pendingChannelId;
    const messageId = this.pendingMessageId;
    this.pendingChannelId = null;
    this.pendingMessageId = null;
    if (!channelId || !messageId) return;
    // 중복 flush 차단: 같은 채널의 동일 messageId 를 이미 보냈으면 생략.
    if (channelId === this.lastFlushedChannelId && messageId === this.lastFlushedMessageId) {
      return;
    }
    this.lastFlushedChannelId = channelId;
    this.lastFlushedMessageId = messageId;
    this.onFlush({
      channelId,
      lastReadMessageId: messageId,
      clientTimestamp: this.now(),
    });
  }
}
