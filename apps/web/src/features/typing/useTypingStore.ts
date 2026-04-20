import { create } from 'zustand';

interface TypingState {
  /** channelId → list of typing userIds (server-authoritative). */
  byChannel: Record<string, string[]>;
  set: (channelId: string, typingUserIds: string[]) => void;
  clear: (channelId: string) => void;
  clearAll: () => void;
}

/**
 * Task-018-F: client-side projection of `typing.updated` events.
 * The backend owns TTL expiry — this store just mirrors the latest
 * server-authoritative set per channel. Re-render happens whenever
 * `byChannel[channelId]` changes identity.
 */
export const useTypingStore = create<TypingState>((set) => ({
  byChannel: {},
  set: (channelId, typingUserIds) =>
    set((s) => ({ byChannel: { ...s.byChannel, [channelId]: typingUserIds } })),
  clear: (channelId) =>
    set((s) => {
      if (!(channelId in s.byChannel)) return s;
      const next = { ...s.byChannel };
      delete next[channelId];
      return { byChannel: next };
    }),
  clearAll: () => set({ byChannel: {} }),
}));
