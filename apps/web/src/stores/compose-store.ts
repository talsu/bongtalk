import { create } from 'zustand';

/**
 * Composer drafts keyed by channel id. Keeping the draft in memory (not
 * localStorage) so it survives channel-switches in a single session but
 * doesn't grow unboundedly across logins.
 */
type ComposeState = {
  drafts: Record<string, string>;
  getDraft: (channelId: string) => string;
  setDraft: (channelId: string, content: string) => void;
  clearDraft: (channelId: string) => void;
};

export const useCompose = create<ComposeState>((set, get) => ({
  drafts: {},
  getDraft: (channelId) => get().drafts[channelId] ?? '',
  setDraft: (channelId, content) => set((s) => ({ drafts: { ...s.drafts, [channelId]: content } })),
  clearDraft: (channelId) =>
    set((s) => {
      if (!(channelId in s.drafts)) return s;
      const { [channelId]: _drop, ...rest } = s.drafts;
      void _drop;
      return { drafts: rest };
    }),
}));
