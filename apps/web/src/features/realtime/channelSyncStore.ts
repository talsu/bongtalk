import { create } from 'zustand';
import type { ChannelSyncState, ChannelSyncEvent } from './channelSyncFsm';
import { transition } from './channelSyncFsm';

/**
 * S10 (FR-RT-07): 채널별 동기화 FSM 상태 스토어.
 *
 * 순수 전이는 channelSyncFsm.transition 이 담당하고, 여기서는 채널별 현재
 * 상태와 truncated 플래그만 보관합니다. UI(예: 동기화 실패 배너/토스트)는
 * 이 스토어를 구독해 SYNC_FAILED / truncated 를 렌더할 수 있습니다.
 */
type ChannelSyncStoreState = {
  /** channelId → 현재 FSM 상태(미보유 = DISCONNECTED 로 간주). */
  states: Record<string, ChannelSyncState>;
  /** channelId → 마지막 동기화가 truncated(일부 누락)였는지. */
  truncated: Record<string, boolean>;
  /** 전이를 적용하고 새 상태를 반환합니다. */
  dispatch: (channelId: string, event: ChannelSyncEvent) => ChannelSyncState;
  setTruncated: (channelId: string, value: boolean) => void;
  get: (channelId: string) => ChannelSyncState;
  reset: (channelId: string) => void;
  clear: () => void;
};

export const useChannelSyncStore = create<ChannelSyncStoreState>((set, get) => ({
  states: {},
  truncated: {},
  dispatch: (channelId, event) => {
    const current = get().states[channelId] ?? 'DISCONNECTED';
    const next = transition(current, event);
    if (next !== current) {
      set((s) => ({ states: { ...s.states, [channelId]: next } }));
    }
    return next;
  },
  setTruncated: (channelId, value) =>
    set((s) => {
      if ((s.truncated[channelId] ?? false) === value) return s;
      return { truncated: { ...s.truncated, [channelId]: value } };
    }),
  get: (channelId) => get().states[channelId] ?? 'DISCONNECTED',
  reset: (channelId) =>
    set((s) => {
      const states = { ...s.states };
      const truncated = { ...s.truncated };
      delete states[channelId];
      delete truncated[channelId];
      return { states, truncated };
    }),
  clear: () => set({ states: {}, truncated: {} }),
}));
