import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMyWorkspaces } from '../../features/workspaces/useWorkspaces';
import { useSearch } from '../../features/search/useSearch';
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
  const [sp] = useSearchParams();
  const initialQ = sp.get('q') ?? '';
  const [input, setInput] = useState(initialQ);
  const [q, setQ] = useState(initialQ);
  // 300ms 디바운스 — 데스크톱 결과 패널과 동일한 요청 절제.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(input.trim()), 300);
    return () => window.clearTimeout(t);
  }, [input]);

  const { data, isFetching } = useSearch({
    workspaceId: ws?.id ?? '',
    q,
    enabled: !!ws && q.length >= 2,
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
            placeholder="메시지 검색 (2자 이상)"
            aria-label="메시지 검색"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        {q.length < 2 ? (
          <div className="qf-m-empty flex-1">
            <div className="qf-m-empty__title">메시지를 검색하세요</div>
            <div className="qf-m-empty__body">검색어를 2자 이상 입력하면 결과가 표시됩니다.</div>
          </div>
        ) : isFetching && results.length === 0 ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">검색 중…</div>
          </div>
        ) : results.length === 0 ? (
          <div className="qf-m-empty flex-1">
            <div className="qf-m-empty__title">결과가 없습니다</div>
            <div className="qf-m-empty__body">다른 검색어로 시도해 보세요.</div>
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
          </ul>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
