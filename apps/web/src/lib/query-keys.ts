/**
 * THE single source of React Query cache keys. Every useQuery / useMutation
 * / setQueryData / invalidateQueries call in the app flows through this
 * file so that:
 *
 *   1. key drift is impossible — a channel list is the same tuple everywhere
 *   2. the realtime dispatcher can derive the exact key from an event
 *   3. the ESLint rule `no-restricted-syntax` bans hard-coded string arrays
 */
export const qk = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  workspaces: {
    list: () => ['workspaces'] as const,
    detail: (wsId: string) => ['workspaces', wsId] as const,
    members: (wsId: string) => ['workspaces', wsId, 'members'] as const,
    invites: (wsId: string) => ['workspaces', wsId, 'invites'] as const,
  },
  channels: {
    list: (wsId: string) => ['workspaces', wsId, 'channels'] as const,
    detail: (chId: string) => ['channels', chId] as const,
    unreadSummary: (wsId: string) => ['workspaces', wsId, 'unread-summary'] as const,
  },
  me: {
    unreadTotals: () => ['me', 'unread-totals'] as const,
  },
  messages: {
    list: (wsId: string, chId: string) => ['messages', wsId, chId] as const,
    detail: (msgId: string) => ['messages', msgId] as const,
    // Task-014-C: thread panel cache is keyed by root id alone because
    // the thread endpoint derives channel + workspace from the id.
    // Keeps the dispatcher branch simple (one key per WS event).
    thread: (rootId: string) => ['messages', 'thread', rootId] as const,
  },
  presence: {
    workspace: (wsId: string) => ['presence', wsId] as const,
  },
} as const;
