// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * S31 (reviewer MAJOR3): 최근 검색 낙관적 삭제의 롤백 회귀. 서버 DELETE 가
 * 실패하면 캐시 + localStorage 가 삭제 이전 상태로 복원돼야 한다(invalidate 로
 * 항목이 부활하면서 localStorage 에서는 사라진 채 불일치가 생기던 버그).
 */

// api 모듈 모킹 — fetch/삭제를 제어한다.
const fetchRecentSearches = vi.fn();
const deleteRecentSearch = vi.fn();
const clearRecentSearches = vi.fn();
vi.mock('./api', () => ({
  fetchRecentSearches: () => fetchRecentSearches(),
  deleteRecentSearch: (entry: string) => deleteRecentSearch(entry),
  clearRecentSearches: () => clearRecentSearches(),
}));

import {
  useRecentSearches,
  pushRecentSearch,
  loadRecentSearches,
  clearLocalRecentSearches,
} from './useSearch';

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  localStorage.clear();
  fetchRecentSearches.mockReset().mockResolvedValue({ recents: [] });
  deleteRecentSearch.mockReset();
  clearRecentSearches.mockReset();
});

afterEach(() => {
  clearLocalRecentSearches();
});

describe('useRecentSearches 낙관적 삭제 롤백 (S31 MAJOR3)', () => {
  it('개별 삭제 실패 시 캐시 + localStorage 가 복원된다(항목 유지)', async () => {
    pushRecentSearch('roadmap');
    pushRecentSearch('deploy');
    // newest-first: ['deploy', 'roadmap']
    deleteRecentSearch.mockRejectedValue(new Error('network'));

    const qc = makeClient();
    const { result } = renderHook(() => useRecentSearches({ enabled: true }), {
      wrapper: wrapper(qc),
    });

    await waitFor(() => expect(result.current.recents).toContain('deploy'));

    act(() => {
      result.current.removeOne('deploy');
    });

    // 삭제 호출이 발화됐고, 실패 후 롤백돼 항목이 유지된다.
    await waitFor(() => expect(deleteRecentSearch).toHaveBeenCalledWith('deploy'));
    await waitFor(() => expect(loadRecentSearches()).toContain('deploy'));
    // localStorage 와 cache 모두 항목을 잃지 않는다.
    expect(loadRecentSearches()).toEqual(expect.arrayContaining(['deploy', 'roadmap']));
  });

  it('개별 삭제 성공 시 항목이 제거된다', async () => {
    pushRecentSearch('roadmap');
    pushRecentSearch('deploy');
    deleteRecentSearch.mockResolvedValue(undefined);

    const qc = makeClient();
    const { result } = renderHook(() => useRecentSearches({ enabled: true }), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.recents).toContain('deploy'));

    act(() => {
      result.current.removeOne('deploy');
    });

    await waitFor(() => expect(deleteRecentSearch).toHaveBeenCalledWith('deploy'));
    await waitFor(() => expect(loadRecentSearches()).not.toContain('deploy'));
  });

  it('전체 삭제 실패 시 localStorage 가 복원된다', async () => {
    pushRecentSearch('roadmap');
    pushRecentSearch('deploy');
    clearRecentSearches.mockRejectedValue(new Error('network'));

    const qc = makeClient();
    const { result } = renderHook(() => useRecentSearches({ enabled: true }), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.recents.length).toBeGreaterThan(0));

    act(() => {
      result.current.clearAll();
    });

    await waitFor(() => expect(clearRecentSearches).toHaveBeenCalled());
    // 실패 → 복원.
    await waitFor(() =>
      expect(loadRecentSearches()).toEqual(expect.arrayContaining(['deploy', 'roadmap'])),
    );
  });
});
