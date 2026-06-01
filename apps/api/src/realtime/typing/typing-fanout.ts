import {
  TYPING_BATCH_INTERVAL,
  TYPING_MAX_VISIBLE,
  TYPING_FANOUT_RATE_LIMIT,
} from '@qufox/shared-types';

/**
 * S32 (FR-RT-08): 채널 typing fanout 의 node-local 정책 엔진.
 *
 * 게이트웨이의 WS/Redis 의존성에서 분리해 결정적으로 단위 테스트할 수 있도록
 * 한 클래스로 모읍니다. 두 가지 관심사를 처리합니다.
 *
 *  1. **batch 타이머** (옵션 A · node-local Map<channelId, Timeout>):
 *     채널의 typing 인원이 TYPING_MAX_VISIBLE(3) 이상이면 단건 emit 대신
 *     TYPING_BATCH_INTERVAL(2000ms) 간격으로 full-snapshot(`typing:batch`)을
 *     emit 합니다. <3 으로 줄면 타이머를 clear 하고 즉시 단건(`typing:update`)
 *     으로 전환합니다. 0명이면 빈 snapshot 으로 clear emit 후 타이머 정리.
 *
 *  2. **채널 fanout rate-limit** (in-memory sliding window):
 *     단건 update 경로에 한해 채널당 초당 TYPING_FANOUT_RATE_LIMIT(10) 상한.
 *     초과분은 drop 합니다(batch 타이머가 다음 주기에 snapshot 으로 보냅니다).
 *
 * 멀티노드 batch 타이머 조정(분산 락)은 단일 NAS 환경에서 무해하므로 carryover.
 *
 * 시간/타이머는 주입 가능합니다(테스트 결정성). `now` 는 rate-limit sliding
 * window 평가에 쓰이고, setTimer/clearTimer 는 batch 주기 타이머에 쓰입니다.
 */
export type TypingFanoutDeps = {
  /** ms epoch. 기본 Date.now — rate-limit window 평가용(테스트는 주입). */
  now?: () => number;
  /** batch 주기 타이머 등록. 기본 setInterval — 테스트는 fake 주입. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** batch 한 사이클의 snapshot 을 emit (full replace). */
  emitBatch: (channelId: string, userIds: string[]) => void;
  /** 단건 update 를 emit. */
  emitUpdate: (channelId: string, userIds: string[]) => void;
  /** 한 사이클에서 채널의 현재 유효 typer 목록(capped)을 비동기로 조회. */
  currentTypers: (channelId: string) => Promise<string[]>;
};

function maxVisible(): number {
  const raw = Number(process.env.TYPING_MAX_VISIBLE ?? TYPING_MAX_VISIBLE);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : TYPING_MAX_VISIBLE;
}

function batchIntervalMs(): number {
  const raw = Number(process.env.TYPING_BATCH_INTERVAL ?? TYPING_BATCH_INTERVAL);
  return Number.isFinite(raw) && raw > 0 ? raw : TYPING_BATCH_INTERVAL;
}

function fanoutRateLimit(): number {
  const raw = Number(process.env.TYPING_FANOUT_RATE_LIMIT ?? TYPING_FANOUT_RATE_LIMIT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : TYPING_FANOUT_RATE_LIMIT;
}

export class TypingFanout {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly emitBatch: (channelId: string, userIds: string[]) => void;
  private readonly emitUpdate: (channelId: string, userIds: string[]) => void;
  private readonly currentTypers: (channelId: string) => Promise<string[]>;

  /** channelId → batch 주기 타이머 핸들 (node-local, 옵션 A). */
  private readonly batchTimers = new Map<string, unknown>();
  /** channelId → 단건 fanout 타임스탬프 슬라이딩 윈도우(ms). */
  private readonly fanoutWindow = new Map<string, number[]>();

  constructor(deps: TypingFanoutDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
    this.emitBatch = deps.emitBatch;
    this.emitUpdate = deps.emitUpdate;
    this.currentTypers = deps.currentTypers;
  }

  /**
   * 채널의 typing 인원이 변했을 때(ping/stop/disconnect) 호출합니다. 현재 유효
   * typer 목록을 받아 batch 모드 진입/유지/이탈을 결정합니다.
   *
   *  - 인원 ≥ maxVisible: batch 모드. 타이머가 없으면 시작하고 즉시 첫 snapshot
   *    을 emit 합니다(2s 를 기다리지 않음). 이후는 타이머가 주기적으로 갱신.
   *  - 인원 < maxVisible: 타이머가 있으면 clear 하고 단건 update 로 전환합니다.
   *    0명이면 빈 snapshot 으로 clear emit(인디케이터 해제).
   */
  onTypersChanged(channelId: string, typers: string[]): void {
    const cap = maxVisible();
    if (typers.length >= cap) {
      if (!this.batchTimers.has(channelId)) {
        // batch 모드 진입: 즉시 첫 snapshot + 주기 타이머 arm.
        this.emitBatch(channelId, typers);
        const handle = this.setTimer(() => {
          void this.batchTick(channelId);
        }, batchIntervalMs());
        if (typeof (handle as { unref?: () => void })?.unref === 'function') {
          (handle as { unref: () => void }).unref();
        }
        this.batchTimers.set(channelId, handle);
      }
      return;
    }
    // < cap: batch 모드였다면 종료하고 단건 경로로 전환.
    if (this.batchTimers.has(channelId)) {
      this.stopBatch(channelId);
    }
    if (typers.length === 0) {
      // 0명: 빈 snapshot 으로 clear(인디케이터 해제). rate-limit 우회 — clear 는
      // 항상 전달돼야 인디케이터가 stuck 되지 않습니다.
      this.emitUpdate(channelId, []);
      return;
    }
    // 1~2명: rate-limit 적용 단건 update.
    if (this.allowFanout(channelId)) {
      this.emitUpdate(channelId, typers);
    }
    // drop 된 경우 다음 ping(또는 batch 진입)이 최신 상태를 싣습니다.
  }

  /** batch 주기 1회: 최신 snapshot 조회 → emit. 0~<cap 으로 줄었으면 종료. */
  private async batchTick(channelId: string): Promise<void> {
    const typers = await this.currentTypers(channelId);
    const cap = maxVisible();
    if (typers.length >= cap) {
      this.emitBatch(channelId, typers);
      return;
    }
    // batch 임계 아래로 떨어짐: 타이머 종료 + 마지막 상태를 단건으로 반영.
    this.stopBatch(channelId);
    this.emitUpdate(channelId, typers);
  }

  private stopBatch(channelId: string): void {
    const handle = this.batchTimers.get(channelId);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.batchTimers.delete(channelId);
    }
  }

  /** sliding-window: 채널당 초당 fanoutRateLimit 초과 시 false(drop). */
  private allowFanout(channelId: string): boolean {
    const now = this.now();
    const limit = fanoutRateLimit();
    const recent = (this.fanoutWindow.get(channelId) ?? []).filter((t) => now - t < 1000);
    if (recent.length >= limit) {
      this.fanoutWindow.set(channelId, recent);
      return false;
    }
    recent.push(now);
    // S32 (reviewer B / perf): 윈도우가 비면 채널 키를 제거해 quiet 채널의 빈
    // 배열이 Map 에 무한 누적되지 않게 합니다. push 직후이므로 여기선 항상
    // 비어 있지 않지만, 윈도우 만료로 0개가 된 경로(아래 set 대신 delete)를
    // 일관 처리해 두면 stop/clear 후 더 이상 fanout 하지 않는 채널이 자연 정리됩니다.
    if (recent.length === 0) this.fanoutWindow.delete(channelId);
    else this.fanoutWindow.set(channelId, recent);
    return true;
  }

  /** 테스트/종료 정리용: 모든 batch 타이머 해제. */
  dispose(): void {
    for (const handle of this.batchTimers.values()) this.clearTimer(handle);
    this.batchTimers.clear();
    this.fanoutWindow.clear();
  }

  /** 테스트 헬퍼: 특정 채널이 batch 모드인지. */
  isBatching(channelId: string): boolean {
    return this.batchTimers.has(channelId);
  }
}
