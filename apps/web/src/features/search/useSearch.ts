import { useInfiniteQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@qufox/shared-types';
import { searchMessages } from './api';

/**
 * Task-015-C: search infinite query. The hook takes an already-
 * debounced `q` so the cache key stays stable during fast typing
 * (the SearchInput owns the debounce). An empty `q` disables the
 * query so the page can render the "recent searches" empty state
 * without firing a no-op request.
 */
export function useSearch(args: { workspaceId: string; q: string; channelId?: string }) {
  return useInfiniteQuery({
    queryKey: ['search', args.workspaceId, args.q, args.channelId ?? null] as const,
    queryFn: ({ pageParam }) =>
      searchMessages({
        workspaceId: args.workspaceId,
        q: args.q,
        channelId: args.channelId,
        cursor: (pageParam as string | undefined) ?? undefined,
        limit: 20,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SearchResponse) => last.nextCursor ?? undefined,
    enabled: args.q.trim().length > 0 && !!args.workspaceId,
  });
}

/**
 * Recent searches — stored only in localStorage (PII stays on device).
 * Bounded at 5, newest-first, de-duped.
 */
const RECENTS_KEY = 'qufox.search.recents';
const RECENTS_MAX = 5;

export function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s: unknown): s is string => typeof s === 'string').slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

export function pushRecentSearch(q: string): string[] {
  const trimmed = q.trim();
  if (trimmed.length === 0) return loadRecentSearches();
  const existing = loadRecentSearches().filter((x) => x !== trimmed);
  const next = [trimmed, ...existing].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage full — fine. */
  }
  return next;
}
