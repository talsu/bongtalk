import { create } from 'zustand';

export type Notification = {
  id: string;
  title?: string;
  body?: string;
  variant: 'info' | 'success' | 'warning' | 'danger' | 'mention';
  ttlMs?: number;
  /**
   * Task-011-B: mention toasts are clickable — clicking fires the
   * optional `onActivate` callback which typically navigates to
   * `/w/:slug/:channel?msg=<id>`. Kept optional so existing info /
   * success / warning toasts stay non-interactive.
   */
  onActivate?: () => void;
  /**
   * S24 (FR-RS-10/18): an inline action button rendered inside the toast
   * (e.g. mark-all-read 의 "실행 취소" Undo). Distinct from `onActivate`
   * (whole-toast click) — the action sits beside the text and dismisses
   * the toast on click. Kept optional so existing toasts are unaffected.
   */
  action?: { label: string; onClick: () => void };
};

type NotificationState = {
  items: Notification[];
  push: (n: Omit<Notification, 'id'>) => string;
  dismiss: (id: string) => void;
};

export const useNotifications = create<NotificationState>((set) => ({
  items: [],
  push: (n) => {
    const id = `tst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({ items: [...s.items, { id, ...n }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
