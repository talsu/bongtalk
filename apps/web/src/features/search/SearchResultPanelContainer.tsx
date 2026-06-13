import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SearchResult, SearchSort } from '@qufox/shared-types';
import { useChannelList } from '../channels/useChannels';
import { useUI } from '../../stores/ui-store';
import { useSearch, pushRecentSearch, useRecentSearches } from './useSearch';
import { SearchResultPanel } from './SearchResultPanel';

/**
 * S30 (FR-S03/S06/S07/S09/S10): 검색 결과 패널 컨테이너. 데이터 fetch +
 * 점프/재검색/최근선택 콜백을 SearchResultPanel(순수 표시)에 주입합니다.
 *
 *  - 활성 쿼리는 ui-store.searchPanelQuery 가 소유(SearchInput 의 Enter 가 설정).
 *  - 결과는 useSearch(withContext=true) — 카드 컨텍스트 + 스레드 루트 excerpt.
 *  - FR-S07: window 'qufox.search.activity' 이벤트(메시지 send 신호)를 받으면
 *    재검색 배너 플래그를 켜고, 재검색/패널 닫힘/쿼리 변경 시 끕니다.
 *  - FR-S06 클릭 점프: `?msg=` 네비게이션 — 채널 MessageColumn 이 around 로드 +
 *    scrollToIndex(S23 시퀀스)로 해당 메시지로 점프합니다.
 */
export function SearchResultPanelContainer({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}): JSX.Element | null {
  const navigate = useNavigate();
  const query = useUI((s) => s.searchPanelQuery);
  const openSearchPanel = useUI((s) => s.openSearchPanel);
  const closeSearchPanel = useUI((s) => s.closeSearchPanel);

  const { data: channelList } = useChannelList(workspaceId);
  const channelNameById = useMemo(() => {
    const map = new Map<string, string>();
    if (!channelList) return map;
    const flat = [
      ...channelList.uncategorized,
      ...channelList.categories.flatMap((c) => c.channels),
    ];
    for (const c of flat) map.set(c.id, c.name);
    return map;
  }, [channelList]);

  const q = query ?? '';
  // 072-N4-2 (FR-S·정렬): 관련도/최신 정렬 토글. 쿼리 변경 시 유지(사용자 선택 존중).
  const [sort, setSort] = useState<SearchSort>('relevance');
  const search = useSearch({ workspaceId, q, withContext: true, sort });
  const results: SearchResult[] = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.results),
    [search.data],
  );

  // FR-S07/S11: 서버측 최근 검색(빈 상태 노출) + 로컬 병합 — SearchInput 과
  // 동일한 공유 hook(react-query 키 재사용)으로 단일 소스. 개별/전체 삭제 포함.
  const { recents, removeOne, clearAll } = useRecentSearches({
    enabled: q.trim().length === 0 && query !== null,
  });

  // FR-S07: index-update 배너 — 패널이 열려 있는 동안 메시지 활동 신호 수신 시 ON.
  const [indexUpdateAvailable, setIndexUpdateAvailable] = useState(false);
  useEffect(() => {
    if (query === null) return;
    const onActivity = (e: Event): void => {
      const detail = (e as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      setIndexUpdateAvailable(true);
    };
    window.addEventListener('qufox.search.activity', onActivity);
    return () => window.removeEventListener('qufox.search.activity', onActivity);
  }, [query, workspaceId]);

  // 쿼리 변경 시 배너 리셋(새 결과 = 최신 상태).
  useEffect(() => {
    setIndexUpdateAvailable(false);
  }, [query]);

  // a11y A-5: 패널이 열려 있는 동안 Esc 로 닫는다. 전역 단축키(useShortcut)는
  // openModal 기준이라 이 패널을 커버하지 못하므로 패널 자체에서 처리한다.
  useEffect(() => {
    if (query === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSearchPanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [query, closeSearchPanel]);

  // 워크스페이스 전환 시 패널을 닫는다(다른 워크스페이스 결과 잔존 방지).
  // closeSearchPanel 은 zustand 의 안정 참조라 deps 에 포함해도 재실행되지 않는다.
  useEffect(() => {
    return () => closeSearchPanel();
  }, [workspaceId, closeSearchPanel]);

  if (query === null) return null;

  const onJump = (r: SearchResult): void => {
    const chName = channelNameById.get(r.channelId);
    if (!chName) return;
    if (q.trim().length > 0) pushRecentSearch(q);
    // 072-N4-1 (FR-S·P0): 점프해도 검색 패널을 닫지 않는다 — 연속 결과 탐색 가능
    // (종전 패널 닫기 호출 제거).
    navigate(`/w/${workspaceSlug}/${chName}?msg=${r.messageId}`);
  };

  return (
    <SearchResultPanel
      query={q}
      results={results}
      sort={sort}
      onSortChange={setSort}
      channelNameById={channelNameById}
      isLoading={search.isLoading}
      hasNextPage={!!search.hasNextPage}
      isFetchingNextPage={search.isFetchingNextPage}
      indexUpdateAvailable={indexUpdateAvailable}
      recents={recents}
      onJump={onJump}
      onLoadMore={() => search.fetchNextPage()}
      onReSearch={() => {
        setIndexUpdateAvailable(false);
        void search.refetch();
      }}
      onPickRecent={(picked) => openSearchPanel(picked)}
      onRemoveRecent={removeOne}
      onClearRecent={clearAll}
      onClose={closeSearchPanel}
    />
  );
}
