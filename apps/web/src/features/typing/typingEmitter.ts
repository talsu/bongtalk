import { TYPING_THROTTLE, TYPING_TTL } from '@qufox/shared-types';

/**
 * S32 (FR-RT-08): 컴포저의 typing:start 스로틀 + 10초 idle 자동 stop 상태 머신.
 *
 * 컴포저(React)에서 분리해 결정적으로 단위 테스트할 수 있게 합니다. 부수효과
 * (emit / setTimeout)는 주입받아 React/socket 의존성 없이 동작합니다.
 *
 *  - onInput(): 입력마다 호출. 첫 입력(또는 스로틀 창 경과 후)에 start 를 emit
 *    하고, 매 호출마다 10초 idle 타이머를 재arm 합니다.
 *  - stop(): 메시지 전송 / draft 비움 / 채널 전환 / 언마운트 / idle 만료 시
 *    호출. stop 을 emit 하고 스로틀·idle 상태를 리셋합니다.
 *  - dispose(): 타이머만 정리(stop emit 없이) — 채널 전환 직전 정리 등.
 */
export type TypingEmitterDeps = {
  emitStart: () => void;
  emitStop: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 테스트 override 용(기본은 공유 상수). */
  throttleMs?: number;
  idleMs?: number;
};

export class TypingEmitter {
  private readonly emitStart: () => void;
  private readonly emitStop: () => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly throttleMs: number;
  private readonly idleMs: number;

  // 아직 한 번도 start 를 보내지 않은 상태. -Infinity 라 첫 onInput 은 항상
  // 스로틀 창 밖으로 판정돼 start 를 emit 합니다(now()=0 인 테스트 clock 에서도
  // 첫 입력이 억제되지 않게).
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private idleHandle: unknown = null;

  constructor(deps: TypingEmitterDeps) {
    this.emitStart = deps.emitStart;
    this.emitStop = deps.emitStop;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.throttleMs = deps.throttleMs ?? TYPING_THROTTLE * 1000;
    this.idleMs = deps.idleMs ?? TYPING_TTL * 1000;
  }

  /** 입력 발생 시 호출. 스로틀 창 밖이면 start emit + idle 타이머 재arm. */
  onInput(): void {
    this.armIdle();
    const t = this.now();
    if (t - this.lastStartAt < this.throttleMs) return;
    this.lastStartAt = t;
    this.emitStart();
  }

  /** 명시적 stop(전송/비움/전환/idle 만료). idle 타이머 정리 + stop emit. */
  stop(): void {
    this.clearIdle();
    // 다음 입력이 다시 첫 입력처럼 start 를 emit 하도록 리셋.
    this.lastStartAt = Number.NEGATIVE_INFINITY;
    this.emitStop();
  }

  /** 타이머만 정리(emit 없음) — 컴포넌트 언마운트 등에서 leak 방지용. */
  dispose(): void {
    this.clearIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleHandle = this.setTimer(() => {
      this.idleHandle = null;
      // idle 만료 → 자동 stop.
      this.stop();
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleHandle !== null) {
      this.clearTimer(this.idleHandle);
      this.idleHandle = null;
    }
  }
}
