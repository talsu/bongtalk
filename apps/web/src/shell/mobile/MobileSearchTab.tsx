import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMyWorkspaces } from '../../features/workspaces/useWorkspaces';
import { useSearch } from '../../features/search/useSearch';
// 071-M4 (FR-S13 게이트 정렬): 종전 로컬 2자 게이트는 공유 게이트(3자 또는 수식어)와
// 어긋나 2자 쿼리가 '검색 중…' 후 무결과처럼 보이는 거짓 UX 였다 — 단일 출처로 정렬.
import { isSearchQueryAllowed, MIN_FREE_TEXT_LENGTH } from '../../features/search/searchQueryGate';
import { markOnlyHtml } from '../../features/search/sanitize';
import { Icon } from '../../design-system/primitives';
import { MobileTabBar } from './MobileTabBar';

/**
 * 071-M2 E3 (FR-S07 모바일 / PRD §02 5탭): 검색 탭 — 풀스크린 검색 + Jump.
 *
 * 데이터는 데스크톱 검색과 동일한 useSearch(워크스페이스 스코프, 서버
 * ts_headline `<mark>` 스니펫 — markOnlyHtml 로 belt-and-suspenders 정화 후
 * 렌더, 데스크톱 SearchResultsPanel 과 동일 처리). 결과 탭 → 채널 라우트 +
 * `?msg=<id>` 점프(M1 D6 의 모바일 ?msg= 소비 — 스크롤+2s 하이라이트) = Jump.
 * 워크스페이스 컨텍스트는 마지막 채팅 경로의 slug(없으면 첫 워크스페이스).
 */
export function MobileSearchTab(): JSX.Element {
  const navigate = useNavigate();
  const { data: mine } = useMyWorkspaces();
  const lastSlug = useMemo(() => {
    try {
      const last = sessionStorage.getItem('qf:lastChatPath');
      const m = last?.match(/^\/w\/([^/]+)\//);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }, []);
  const ws = mine?.workspaces.find((w) => w.slug === lastSlug) ?? mine?.workspaces[0] ?? null;

  // 071-M2 E6 (FR-SC-08): /search 슬래시 커맨드의 키워드 pre-fill(?q=).
  const [sp, setSp] = useSearchParams();
  const initialQ = sp.get('q') ?? '';
  const [input, setInput] = useState(initialQ);
  const [q, setQ] = useState(initialQ);
  // 300ms 디바운스 — 데스크톱 결과 패널과 동일한 요청 절제.
  // 071-M4 (FR-S07 복귀 AC): 확정 쿼리를 ?q= 에 동기화해 Jump 후 브라우저 back
  // 으로 복귀했을 때 검색어/결과가 복원되게 한다(종전엔 state 전용이라 소실).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = input.trim();
      setQ(next);
      setSp(next ? { q: next } : {}, { replace: true });
    }, 300);
    return () => window.clearTimeout(t);
  }, [input, setSp]);

  const allowed = isSearchQueryAllowed(q);
  const { data, isFetching, fetchNextPage, hasNextPage, isFetchingNextPage } = useSearch({
    workspaceId: ws?.id ?? '',
    q,
    enabled: !!ws && allowed,
  });
  // useSearch 는 무한 쿼리(페이지당 20) — 첫 페이지부터 평탄화해 렌더.
  const results = data?.pages.flatMap((p) => p.results) ?? [];

  return (
    <div data-testid="mobile-search-tab" className="qf-m-screen qf-m-screen--app">
      <header className="qf-m-topbar qf-m-safe-top">
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">검색</div>
          <div className="qf-m-topbar__subtitle">{ws?.name ?? ''}</div>
        </div>
      </header>
      <main className="qf-m-body flex min-h-0 flex-col overflow-y-auto">
        <div className="qf-m-search m-[var(--m-gutter)]">
          <span className="qf-m-search__icon" aria-hidden>
            <Icon name="search" size="sm" />
          </span>
          <input
            type="search"
            data-testid="mobile-search-input"
            className="qf-m-search__input"
            placeholder={`메시지 검색 (${MIN_FREE_TEXT_LENGTH}자 이상 또는 수식어)`}
            aria-label="메시지 검색"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        {!allowed ? (
          <div className="qf-m-empty flex-1">
            <div className="qf-m-empty__title">메시지를 검색하세요</div>
            <div className="qf-m-empty__body">
              검색어를 {MIN_FREE_TEXT_LENGTH}자 이상 입력하거나 수식어를 쓰면 결과가 표시됩니다.
            </div>
          </div>
        ) : isFetching && results.length === 0 ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">검색 중…</div>
          </div>
        ) : results.length === 0 ? (
          <div className="qf-m-empty flex-1">
            <div className="qf-m-empty__title">결과가 없습니다</div>
            {/* 071-M4 (FR-S14): 수식어 힌트 + 구체 예시 — 데스크톱 빈 상태와 동급. */}
            <div className="qf-m-empty__body">
              수식어로 좁혀보세요. 예: from:@alice in:#general 배포
            </div>
          </div>
        ) : (
          <ul aria-label="검색 결과" data-testid="mobile-search-results">
            {results.map((r) => (
              <li key={r.messageId}>
                <button
                  type="button"
                  data-testid={`mobile-search-hit-${r.messageId}`}
                  className="qf-m-row w-full text-left"
                  onClick={() => {
                    if (!ws) return;
                    navigate(`/w/${ws.slug}/${r.channelName}?msg=${r.messageId}`);
                  }}
                >
                  <Icon name="hash" size="sm" className="text-text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="qf-m-row__primary block truncate">
                      {r.senderName} · #{r.channelName}
                    </span>
                    {/* 서버가 HTML-escape + <mark> 래핑 — markOnlyHtml 로 재정화(데스크톱 동일). */}
                    <span
                      className="qf-m-row__secondary block truncate"
                      dangerouslySetInnerHTML={{ __html: markOnlyHtml(r.snippet) }}
                    />
                  </span>
                  <span className="qf-m-row__time">
                    {new Date(r.createdAt).toLocaleDateString('ko-KR', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </button>
              </li>
            ))}
            {/* 071-M4 (FR-S09): 페이지네이션 트리거 — 종전엔 첫 페이지(20건)만 도달 가능. */}
            {hasNextPage ? (
              <li>
                <button
                  type="button"
                  data-testid="mobile-search-more"
                  className="qf-m-row w-full justify-center text-text-muted"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? '불러오는 중…' : '더 보기'}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
