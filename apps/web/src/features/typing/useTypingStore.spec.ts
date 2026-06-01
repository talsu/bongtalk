import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTypingStore, type TypingTimerScheduler } from './useTypingStore';

/**
 * S32 (FR-RT-09): per-userId 10초 만료 타이머 검증. 실제 setTimeout 대신 수동
 * 발화 fake scheduler 를 주입해 결정적으로 만료를 흘립니다.
 */
type Scheduled = { fn: () => void; ms: number; handle: number };

function fakeScheduler(): {
  scheduler: TypingTimerScheduler;
  fireAll: () => void;
  fireOne: (i: number) => void;
  pending: () => Scheduled[];
} {
  let seq = 0;
  const scheduled = new Map<number, Scheduled>();
  const scheduler: TypingTimerScheduler = {
    schedule: (fn, ms) => {
      const handle = ++seq;
      scheduled.set(handle, { fn, ms, handle });
      return handle;
    },
    cancel: (handle) => {
      scheduled.delete(handle as number);
    },
  };
  return {
    scheduler,
    pending: () => [...scheduled.values()],
    fireAll: () => {
      for (const s of [...scheduled.values()]) {
        scheduled.delete(s.handle);
        s.fn();
      }
    },
    fireOne: (i) => {
      const arr = [...scheduled.values()];
      const s = arr[i];
      if (s) {
        scheduled.delete(s.handle);
        s.fn();
      }
    },
  };
}

const CH = 'channel-1';

beforeEach(() => {
  useTypingStore.setState({ byChannel: {} });
});

afterEach(() => {
  useTypingStore.getState().clearAll();
});

describe('useTypingStore per-userId TTL (S32 · FR-RT-09)', () => {
  it('set 은 snapshot 을 반영하고 userId 별 타이머를 arm 한다', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set(CH, ['a', 'b']);
    expect(useTypingStore.getState().byChannel[CH]).toEqual(['a', 'b']);
    // a, b 각각 10초 타이머.
    expect(fk.pending().length).toBe(2);
    expect(fk.pending().every((s) => s.ms === 10_000)).toBe(true);
  });

  it('타이머 만료 시 해당 userId 만 제거', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set(CH, ['a', 'b']);
    // a 의 타이머만 발화 → a 제거, b 잔존.
    fk.fireOne(0);
    expect(useTypingStore.getState().byChannel[CH]).toEqual(['b']);
  });

  it('마지막 userId 만료 시 채널 키 자체가 제거된다', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set(CH, ['a']);
    fk.fireAll();
    expect(CH in useTypingStore.getState().byChannel).toBe(false);
  });

  it('동일 userId 재set 은 기존 타이머를 clear 하고 새로 arm (TTL 갱신)', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set(CH, ['a']);
    useTypingStore.getState().set(CH, ['a']);
    // 이전 타이머는 cancel 되고 새 타이머 1개만 남는다.
    expect(fk.pending().length).toBe(1);
  });

  it('full-replace: snapshot 에서 빠진 userId 의 타이머는 즉시 정리', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set(CH, ['a', 'b']);
    useTypingStore.getState().set(CH, ['a']); // b 빠짐
    expect(useTypingStore.getState().byChannel[CH]).toEqual(['a']);
    // a 의 타이머 1개만 남고 b 타이머는 정리.
    expect(fk.pending().length).toBe(1);
  });

  it('빈 snapshot([]) 은 채널 키를 제거하고 타이머를 정리', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set(CH, ['a', 'b']);
    useTypingStore.getState().set(CH, []);
    expect(CH in useTypingStore.getState().byChannel).toBe(false);
    expect(fk.pending().length).toBe(0);
  });

  it('clearAll 은 전체 상태와 모든 타이머를 정리(disconnect)', () => {
    const fk = fakeScheduler();
    useTypingStore.getState()._setScheduler(fk.scheduler);
    useTypingStore.getState().set('ch-1', ['a']);
    useTypingStore.getState().set('ch-2', ['b']);
    useTypingStore.getState().clearAll();
    expect(useTypingStore.getState().byChannel).toEqual({});
    expect(fk.pending().length).toBe(0);
  });
});
