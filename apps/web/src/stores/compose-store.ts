import { create } from 'zustand';

/**
 * Composer drafts keyed by channel id + (optionally) thread root id.
 * Keeping the draft in memory (not localStorage) so it survives channel
 * switches / thread panel close-reopen in a single session without
 * growing unboundedly across logins.
 *
 * Thread reply drafts use `thread:<rootId>` as their key so channel
 * drafts and thread drafts never collide.
 */
type ComposeState = {
  drafts: Record<string, string>;
  getDraft: (key: string) => string;
  setDraft: (key: string, content: string) => void;
  clearDraft: (key: string) => void;
};

export const useCompose = create<ComposeState>((set, get) => ({
  drafts: {},
  getDraft: (key) => get().drafts[key] ?? '',
  setDraft: (key, content) => set((s) => ({ drafts: { ...s.drafts, [key]: content } })),
  clearDraft: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const { [key]: _drop, ...rest } = s.drafts;
      void _drop;
      return { drafts: rest };
    }),
}));

export const threadDraftKey = (rootId: string): string => `thread:${rootId}`;
