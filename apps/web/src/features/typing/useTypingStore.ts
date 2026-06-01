import { create } from 'zustand';
import { TYPING_TTL } from '@qufox/shared-types';

/**
 * S32 (FR-RT-09): per-userId 클라이언트 측 만료 타이머 주입 포인트.
 *
 * 기본은 브라우저 setTimeout/clearTimeout. 테스트는 fake timer 또는 직접
 * 주입한 schedule/cancel 로 결정적으로 검증합니다. 서버 push 가 누락돼도
 * 수신 측이 userId 별 10초 타이머로 인디케이터를 스스로 소멸시킵니다.
 */
export interface TypingTimerScheduler {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

const DEFAULT_SCHEDULER: TypingTimerScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** TTL_TTL 초 → ms. 서버 ZSET TTL 과 동일 값(단일 출처). */
const TYPING_TTL_MS = TYPING_TTL * 1000;

interface TypingState {
  /** channelId → list of typing userIds (server-authoritative snapshot). */
  byChannel: Record<string, string[]>;
  /**
   * S32 (FR-RT-09): set 이 받은 snapshot 을 store 에 반영하면서, snapshot 에 든
   * 각 userId 마다 기존 만료 타이머를 clear 하고 새 10초(TYPING_TTL) 타이머를
   * arm 합니다. 만료 시 해당 userId 만 채널 목록에서 제거하고, 채널이 비면 키를
   * 삭제합니다. snapshot 은 full-replace(merge 아님) — snapshot 에서 빠진 userId
   * 의 잔여 타이머는 즉시 정리합니다.
   */
  set: (channelId: string, typingUserIds: string[]) => void;
  clear: (channelId: string) => void;
  /** disconnect 이벤트 시 전체 클리어 + 모든 타이머 정리. */
  clearAll: () => void;
  /** 테스트/HMR 용: 타이머 스케줄러 교체(주입 결정성). */
  _setScheduler: (s: TypingTimerScheduler) => void;
}

export const useTypingStore = create<TypingState>((set) => {
  // 스토어 내부에서 관리하는 per-(channelId,userId) 타이머 핸들 맵. 언마운트/HMR
  // leak 을 피하기 위해 store closure 안에 둡니다(컴포넌트 수명과 무관).
  let scheduler: TypingTimerScheduler = DEFAULT_SCHEDULER;
  const timers = new Map<string, Map<string, unknown>>();

  const timerKey = (channelId: string): Map<string, unknown> => {
    let m = timers.get(channelId);
    if (!m) {
      m = new Map();
      timers.set(channelId, m);
    }
    return m;
  };

  const cancelTimer = (channelId: string, userId: string): void => {
    const m = timers.get(channelId);
    const h = m?.get(userId);
    if (h !== undefined) {
      scheduler.cancel(h);
      m?.delete(userId);
    }
  };

  const cancelChannel = (channelId: string): void => {
    const m = timers.get(channelId);
    if (!m) return;
    for (const h of m.values()) scheduler.cancel(h);
    timers.delete(channelId);
  };

  const expireUser = (channelId: string, userId: string): void => {
    cancelTimer(channelId, userId);
    set((s) => {
      const current = s.byChannel[channelId];
      if (!current || !current.includes(userId)) return s;
      const next = current.filter((id) => id !== userId);
      const nextByChannel = { ...s.byChannel };
      if (next.length === 0) delete nextByChannel[channelId];
      else nextByChannel[channelId] = next;
      return { byChannel: nextByChannel };
    });
  };

  return {
    byChannel: {},
    set: (channelId, typingUserIds) => {
      const incoming = new Set(typingUserIds);
      // snapshot 에서 빠진 userId 의 잔여 타이머 정리(full-replace 의미).
      const existing = timerKey(channelId);
      for (const userId of [...existing.keys()]) {
        if (!incoming.has(userId)) cancelTimer(channelId, userId);
      }
      // snapshot 에 든 각 userId: 기존 타이머 clear + 새 10s 타이머 arm.
      for (const userId of incoming) {
        cancelTimer(channelId, userId);
        const handle = scheduler.schedule(() => expireUser(channelId, userId), TYPING_TTL_MS);
        timerKey(channelId).set(userId, handle);
      }
      // 빈 snapshot 이면 채널 키 자체를 제거(인디케이터 해제).
      set((s) => {
        const nextByChannel = { ...s.byChannel };
        if (typingUserIds.length === 0) delete nextByChannel[channelId];
        else nextByChannel[channelId] = typingUserIds;
        return { byChannel: nextByChannel };
      });
    },
    clear: (channelId) => {
      cancelChannel(channelId);
      set((s) => {
        if (!(channelId in s.byChannel)) return s;
        const next = { ...s.byChannel };
        delete next[channelId];
        return { byChannel: next };
      });
    },
    clearAll: () => {
      for (const channelId of [...timers.keys()]) cancelChannel(channelId);
      set({ byChannel: {} });
    },
    _setScheduler: (s) => {
      // 교체 전 모든 타이머 정리(이전 스케줄러 핸들 leak 방지).
      for (const channelId of [...timers.keys()]) cancelChannel(channelId);
      scheduler = s;
    },
  };
});
