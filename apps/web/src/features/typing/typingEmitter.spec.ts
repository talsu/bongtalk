import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingEmitter, type TypingEmitterDeps } from './typingEmitter';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S32 (FR-RT-08): 컴포저 typing:start 스로틀 + 10초 idle 자동 stop 검증.
 * 수동 발화 fake timer + 주입 clock 으로 결정적으로 흘립니다.
 */
function harness() {
  const starts = { n: 0 };
  const stops = { n: 0 };
  let now = 0;
  let timerCb: (() => void) | null = null;
  let timerMs = 0;
  let cleared = false;

  const deps: TypingEmitterDeps = {
    emitStart: () => (starts.n += 1),
    emitStop: () => (stops.n += 1),
    now: () => now,
    setTimer: (fn, ms) => {
      timerCb = fn;
      timerMs = ms;
      cleared = false;
      return { id: 1 };
    },
    clearTimer: () => {
      cleared = true;
      timerCb = null;
    },
  };
  return {
    emitter: new TypingEmitter(deps),
    starts,
    stops,
    setNow: (n: number) => (now = n),
    fireIdle: () => {
      if (timerCb) timerCb();
    },
    idleMs: () => timerMs,
    isCleared: () => cleared,
  };
}

describe('TypingEmitter 스로틀 (FR-RT-08)', () => {
  it('첫 입력에 start 1회 emit', () => {
    const h = harness();
    h.emitter.onInput();
    expect(h.starts.n).toBe(1);
  });

  it('3초 스로틀 창 안의 연속 입력은 start 1회만', () => {
    const h = harness();
    h.setNow(0);
    h.emitter.onInput(); // start
    h.setNow(1000);
    h.emitter.onInput(); // 창 안 → skip
    h.setNow(2999);
    h.emitter.onInput(); // 창 안 → skip
    expect(h.starts.n).toBe(1);
    // 3초 경과 후 재전송.
    h.setNow(3001);
    h.emitter.onInput();
    expect(h.starts.n).toBe(2);
  });
});

describe('TypingEmitter idle 10초 자동 stop (FR-RT-08)', () => {
  it('idle 타이머는 10초(TYPING_TTL)로 arm 된다', () => {
    const h = harness();
    h.emitter.onInput();
    expect(h.idleMs()).toBe(10_000);
  });

  it('10초 무입력 idle 만료 시 stop 자동 emit', () => {
    const h = harness();
    h.emitter.onInput();
    expect(h.stops.n).toBe(0);
    h.fireIdle();
    expect(h.stops.n).toBe(1);
  });

  it('입력이 이어지면 idle 타이머가 재arm 되어 stop 이 지연된다', () => {
    const h = harness();
    h.setNow(0);
    h.emitter.onInput();
    h.setNow(5000);
    h.emitter.onInput(); // idle 재arm
    // 직전 타이머는 cancel 되고 새 타이머가 arm.
    expect(h.isCleared()).toBe(false); // 새 타이머가 살아 있음
    h.fireIdle();
    expect(h.stops.n).toBe(1);
  });

  it('명시적 stop(전송/비움/전환)은 idle 타이머를 정리하고 stop emit', () => {
    const h = harness();
    h.emitter.onInput();
    h.emitter.stop();
    expect(h.stops.n).toBe(1);
    expect(h.isCleared()).toBe(true);
  });

  it('stop 이후 다음 입력은 start 를 다시 emit (lastStart 리셋)', () => {
    const h = harness();
    h.setNow(0);
    h.emitter.onInput(); // start #1
    h.emitter.stop();
    h.setNow(500); // 스로틀 창 안이지만 stop 으로 리셋됐으므로...
    h.emitter.onInput(); // start #2
    expect(h.starts.n).toBe(2);
  });

  it('dispose 는 emit 없이 타이머만 정리', () => {
    const h = harness();
    h.emitter.onInput();
    h.emitter.dispose();
    expect(h.isCleared()).toBe(true);
    expect(h.stops.n).toBe(0);
  });
});
