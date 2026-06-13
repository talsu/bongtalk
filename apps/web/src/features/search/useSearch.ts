import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecentSearchesResponse, SearchResponse, SearchSort } from '@qufox/shared-types';
import {
  searchMessages,
  fetchRecentSearches,
  deleteRecentSearch as apiDeleteRecentSearch,
  clearRecentSearches as apiClearRecentSearches,
} from './api';
import { isSearchQueryAllowed } from './searchQueryGate';

/**
 * Task-015-C: search infinite query. The hook takes an already-
 * debounced `q` so the cache key stays stable during fast typing
 * (the SearchInput owns the debounce). An empty `q` disables the
 * query so the page can render the "recent searches" empty state
 * without firing a no-op request.
 */
export function useSearch(args: {
  workspaceId: string;
  q: string;
  channelId?: string;
  /** S30 (FR-S06/S10): 결과 패널은 컨텍스트 + 스레드 루트 excerpt 가 필요. */
  withContext?: boolean;
  /** 072-N4-2 (FR-S 정렬): relevance(기본) | recent. queryKey 에 포함. */
  sort?: SearchSort;
  /**
   * S31 (NIT4): 호출측이 결과 쿼리를 일시 비활성화할 수 있다(예: suggest 모드
   * 활성 — 결과 드롭다운을 보여주지 않으므로 요청 낭비). 기본 true.
   */
  enabled?: boolean;
}) {
  return useInfiniteQuery({
    queryKey: [
      'search',
      args.workspaceId,
      args.q,
      args.channelId ?? null,
      args.withContext ? 'ctx' : 'plain',
      args.sort ?? 'relevance',
    ] as const,
    queryFn: ({ pageParam }) =>
      searchMessages({
        workspaceId: args.workspaceId,
        q: args.q,
        channelId: args.channelId,
        cursor: (pageParam as string | undefined) ?? undefined,
        // S30 (FR-S09): 페이지당 20, 더 보기로 누적(서버 max 100/5페이지).
        limit: 20,
        withContext: args.withContext,
        sort: args.sort,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SearchResponse) => last.nextCursor ?? undefined,
    // S31 (FR-S13): 순수 길이가 아니라 파서 기반 게이트 — 수식어가 있으면
    // 자유 텍스트 0자여도 허용, 없으면 3자 이상만 서버 요청. NIT4: 호출측이
    // enabled=false 를 넘기면(예: suggest 모드) 결과 쿼리를 비활성화한다.
    enabled: (args.enabled ?? true) && !!args.workspaceId && isSearchQueryAllowed(args.q),
  });
}

/**
 * Recent searches — local mirror in localStorage (PII stays on device) +
 * server merge. S31 (FR-S11): 상한을 서버(Redis)와 동일하게 10 으로 통일한다.
 */
const RECENTS_KEY = 'qufox.search.recents';
const RECENTS_MAX = 10;
/** S31 (FR-S11): 서버/로컬 병합 recents 의 react-query 키. */
export const RECENT_SEARCH_QUERY_KEY = ['search', 'recent'] as const;

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

/** S31 (FR-S11): localStorage 에서 단일 엔트리 제거. */
export function removeLocalRecentSearch(entry: string): string[] {
  const next = loadRecentSearches().filter((x) => x !== entry);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/** S31 (FR-S11): localStorage recents 전체 비우기. */
export function clearLocalRecentSearches(): void {
  try {
    localStorage.removeItem(RECENTS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * S31 (reviewer MAJOR3): 낙관적 삭제 실패 시 localStorage recents 를 스냅샷으로
 * 되돌리기 위한 전체 덮어쓰기. 상한(RECENTS_MAX)은 항상 유지한다.
 */
export function writeLocalRecentSearches(entries: string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(entries.slice(0, RECENTS_MAX)));
  } catch {
    /* localStorage full — fine. */
  }
}

/**
 * S31 (FR-S11): 최근 검색의 단일 소스. 서버(Redis) recents 와 localStorage 를
 * 병합(서버 우선, 중복 제거)해 newest-first 로 노출하고, 개별/전체 삭제를
 * 제공합니다. SearchInput 드롭다운과 결과 패널이 동일 hook 을 공유해 일관된
 * 목록을 보여줍니다(react-query 키 재사용).
 */
export function useRecentSearches(args: { enabled?: boolean } = {}): {
  recents: string[];
  isLoading: boolean;
  removeOne: (_entry: string) => void;
  clearAll: () => void;
} {
  const enabled = args.enabled ?? true;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: RECENT_SEARCH_QUERY_KEY,
    queryFn: fetchRecentSearches,
    enabled,
    staleTime: 30_000,
  });

  const recents = useMemo(() => {
    const server = query.data?.recents ?? [];
    const local = loadRecentSearches();
    const merged: string[] = [];
    for (const x of [...server, ...local]) {
      if (!merged.includes(x)) merged.push(x);
    }
    return merged.slice(0, RECENTS_MAX);
  }, [query.data]);

  const removeOne = useCallback(
    (entry: string) => {
      // S31 (reviewer MAJOR3): 낙관적 삭제는 실패 시 롤백해야 한다. 이전엔
      // .catch 가 에러를 삼키고 invalidate 만 했는데, 서버 삭제가 실제로
      // 실패하면 재조회 시 항목이 부활하면서 localStorage 에서는 사라진 채라
      // 불일치가 생겼다. 쓰기 전 캐시 + localStorage 를 스냅샷하고, 실패 시
      // 복원한 다음에만 재조회한다.
      const prevCache = qc.getQueryData<RecentSearchesResponse>(RECENT_SEARCH_QUERY_KEY);
      const prevLocal = loadRecentSearches();
      const local = removeLocalRecentSearch(entry);
      qc.setQueryData<RecentSearchesResponse>(RECENT_SEARCH_QUERY_KEY, (prev) => ({
        recents: (prev?.recents ?? local).filter((x) => x !== entry),
      }));
      void apiDeleteRecentSearch(entry)
        .then(() => {
          // 성공 시에만 서버 권위 상태로 재동기화.
          void qc.invalidateQueries({ queryKey: RECENT_SEARCH_QUERY_KEY });
        })
        .catch(() => {
          // 실패 → 낙관적 변경을 되돌린다(캐시 + localStorage 모두).
          writeLocalRecentSearches(prevLocal);
          qc.setQueryData<RecentSearchesResponse>(
            RECENT_SEARCH_QUERY_KEY,
            prevCache ?? { recents: prevLocal },
          );
        });
    },
    [qc],
  );

  const clearAll = useCallback(() => {
    // S31 (reviewer MAJOR3): 전체 삭제도 동일하게 스냅샷 → 실패 시 복원.
    const prevCache = qc.getQueryData<RecentSearchesResponse>(RECENT_SEARCH_QUERY_KEY);
    const prevLocal = loadRecentSearches();
    clearLocalRecentSearches();
    qc.setQueryData<RecentSearchesResponse>(RECENT_SEARCH_QUERY_KEY, { recents: [] });
    void apiClearRecentSearches()
      .then(() => {
        void qc.invalidateQueries({ queryKey: RECENT_SEARCH_QUERY_KEY });
      })
      .catch(() => {
        writeLocalRecentSearches(prevLocal);
        qc.setQueryData<RecentSearchesResponse>(
          RECENT_SEARCH_QUERY_KEY,
          prevCache ?? { recents: prevLocal },
        );
      });
  }, [qc]);

  return { recents, isLoading: query.isLoading, removeOne, clearAll };
}
