import { create } from 'zustand';

export type Notification = {
  id: string;
  title?: string;
  body?: string;
  variant: 'info' | 'success' | 'warning' | 'danger';
  ttlMs?: number;
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
