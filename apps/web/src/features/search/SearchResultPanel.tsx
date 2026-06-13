import { useEffect, useRef } from 'react';
import type { SearchResult, SearchSort } from '@qufox/shared-types';
import { Avatar, Icon } from '../../design-system/primitives';
import { searchSnippetHtml } from './sanitize';
import {
  IN_THREAD_LABEL,
  INDEX_UPDATE_BANNER_TEXT,
  SEARCH_CHEAT_SHEET,
  contextDisplayText,
  emptyStateHint,
} from './searchResultView';

/**
 * S30 fix-forward (a11y A-1): 결과 카드 접근명에 쓸 plain-text snippet.
 * snippet 은 ts_headline 의 `<mark>` HTML 을 담으므로 태그를 제거해
 * aria-label 에 안전한 평문만 남깁니다(시각 렌더는 sanitize 경로가 별도 처리).
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * S30 (FR-S03 / FR-S06 / FR-S07 / FR-S09 / FR-S10):
 * 검색 결과 패널(슬라이드인, 우측 패널 대체). 순수 표시 컴포넌트 — 데이터/콜백을
 * prop 으로 받아 DS `qf-search-overlay*` 클래스로 렌더합니다. 점프/페이지네이션/
 * 재검색/최근선택 동작은 모두 콜백으로 위임합니다(상태는 상위 hook 이 소유).
 *
 * 사용 DS 클래스: qf-search-overlay, __results, __result, __result-ctx,
 * __result-preview, __jump (전부 기존 — 신규 0). 신규 시각 요소(배너/빈상태/
 * 컨텍스트 회색줄/In Thread)는 DS 토큰만 사용한 Tailwind arbitrary 로 표현합니다.
 */

type Props = {
  /** 디바운스된 현재 쿼리(빈 문자열이면 최근검색 노출). */
  query: string;
  results: SearchResult[];
  /** 072-N4-2: 정렬(relevance|recent) + 변경 콜백. */
  sort: SearchSort;
  onSortChange: (_s: SearchSort) => void;
  channelNameById: Map<string, string>;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** FR-S07: 새 결과 가능 배너 표시 여부. */
  indexUpdateAvailable: boolean;
  /** FR-S07: 패널 빈 상태에 노출할 최근 검색어(서버/로컬 병합). */
  recents: string[];
  onJump: (_r: SearchResult) => void;
  onLoadMore: () => void;
  onReSearch: () => void;
  onPickRecent: (_q: string) => void;
  /** FR-S11: 최근 검색 개별 삭제. */
  onRemoveRecent: (_q: string) => void;
  /** FR-S11: 최근 검색 전체 삭제. */
  onClearRecent: () => void;
  onClose: () => void;
};

export function SearchResultPanel({
  query,
  results,
  sort,
  onSortChange,
  channelNameById,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  indexUpdateAvailable,
  recents,
  onJump,
  onLoadMore,
  onReSearch,
  onPickRecent,
  onRemoveRecent,
  onClearRecent,
  onClose,
}: Props): JSX.Element {
  const trimmed = query.trim();
  const showRecents = trimmed.length === 0;
  const isEmpty = !showRecents && !isLoading && results.length === 0;

  // a11y A-4: 패널이 열리면 포커스를 패널로 옮겨 키보드/SR 사용자가 맥락을
  // 잃지 않게 합니다(tabIndex=-1 로 프로그램적 포커스만 허용).
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // S31 (a11y S-2): 최근 검색 개별/전체 삭제 후 포커스가 사라진 버튼과 함께
  // 소실되지 않도록 패널로 되돌린다.
  const handleRemoveRecent = (q: string): void => {
    onRemoveRecent(q);
    panelRef.current?.focus();
  };
  const handleClearRecent = (): void => {
    onClearRecent();
    panelRef.current?.focus();
  };

  // 072-N4-2(리뷰 HIGH): WAI-ARIA tablist 키보드 — roving tabindex + 화살표 이동/선택.
  const SORT_OPTIONS: { v: SearchSort; label: string }[] = [
    { v: 'relevance', label: '관련도순' },
    { v: 'recent', label: '최신순' },
  ];
  const tabRefs = useRef<Record<SearchSort, HTMLButtonElement | null>>({
    relevance: null,
    recent: null,
  });
  const moveSort = (idx: number, dir: number): void => {
    const next = SORT_OPTIONS[(idx + dir + SORT_OPTIONS.length) % SORT_OPTIONS.length];
    onSortChange(next.v);
    tabRefs.current[next.v]?.focus();
  };

  // a11y A-6: 결과 상태를 aria-live 영역에 1줄로 통지(SR 전용).
  const statusText = isLoading
    ? '검색 중'
    : isEmpty
      ? '결과 없음'
      : showRecents
        ? ''
        : `${results.length}건의 검색 결과`;

  return (
    <aside
      ref={panelRef}
      data-testid="search-result-panel"
      // DS violation 회피(70vh 클리핑): qf-search-overlay 는 DS 에서 floating
      // overlay(max-height:70vh + radius + shadow)라 floor-to-ceiling 슬롯에서
      // 잘리고 라운드/그림자가 뜬다. DS 수정 금지이므로 Tailwind 로 오버라이드.
      className="qf-search-overlay h-full w-thread max-w-full max-h-none rounded-none shadow-none"
      // 우측 패널(ThreadPanel 과 동일 슬롯) 자리에 floor-to-ceiling.
      role="complementary"
      aria-label="검색 결과"
      tabIndex={-1}
    >
      <div className="qf-search-overlay__bar">
        <Icon name="search" />
        <span className="qf-search-overlay__input flex items-center">
          {trimmed.length > 0 ? `검색: ${trimmed}` : '검색'}
        </span>
        <button
          type="button"
          data-testid="search-panel-close"
          aria-label="검색 결과 닫기"
          onClick={onClose}
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      {/* 072-N4-2 (FR-S 정렬): 결과 모드일 때만 관련도/최신 정렬 탭 노출(WAI-ARIA tablist). */}
      {!showRecents ? (
        <div role="tablist" aria-label="검색 정렬" className="qf-tabs px-[var(--s-5)]">
          {SORT_OPTIONS.map((opt, idx) => (
            <button
              key={opt.v}
              ref={(el) => {
                tabRefs.current[opt.v] = el;
              }}
              type="button"
              role="tab"
              id={`search-sort-tab-${opt.v}`}
              aria-selected={sort === opt.v}
              aria-controls="search-panel-results"
              tabIndex={sort === opt.v ? 0 : -1}
              data-testid={`search-sort-${opt.v}`}
              onClick={() => onSortChange(opt.v)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  moveSort(idx, +1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  moveSort(idx, -1);
                }
              }}
              className="qf-tabs__item"
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* FR-S07: index-update 배너 — 패널 닫힘/재검색까지 유지. */}
      {indexUpdateAvailable ? (
        <button
          type="button"
          data-testid="search-index-update-banner"
          onClick={onReSearch}
          className="flex w-full items-center gap-[var(--s-2)] border-b border-[var(--divider)] bg-[var(--accent-subtle)] px-[var(--s-5)] py-[var(--s-2)] text-left text-[length:var(--fs-12)] text-[color:var(--a-200)]"
        >
          <Icon name="refresh" size="sm" />
          {INDEX_UPDATE_BANNER_TEXT}
        </button>
      ) : null}

      <div
        className="qf-search-overlay__results"
        data-testid="search-panel-results"
        // 072-N4-2(리뷰): 정렬 탭의 tabpanel(아이디로 aria-controls 연결). 최근검색
        // 모드(탭 없음)에선 tabpanel 역할을 부여하지 않는다.
        id="search-panel-results"
        role={!showRecents ? 'tabpanel' : undefined}
        aria-labelledby={!showRecents ? `search-sort-tab-${sort}` : undefined}
        // a11y A-6: 결과 갱신을 SR 에 부드럽게 통지(정중하게, 누적 X).
        aria-live="polite"
        aria-atomic="false"
      >
        {/* a11y A-6: SR 전용 상태 텍스트(시각 숨김). 빈 문자열이면 침묵. */}
        <span role="status" className="sr-only" data-testid="search-panel-status">
          {statusText}
        </span>
        {showRecents ? (
          <RecentSearchList
            recents={recents}
            onPick={onPickRecent}
            onRemove={handleRemoveRecent}
            onClear={handleClearRecent}
          />
        ) : isLoading ? (
          <div
            data-testid="search-panel-loading"
            className="px-[var(--s-4)] py-[var(--s-5)] text-center text-[length:var(--fs-12)] text-[color:var(--text-muted)]"
          >
            검색 중…
          </div>
        ) : isEmpty ? (
          <div
            data-testid="search-panel-empty"
            data-state="empty"
            className="px-[var(--s-4)] py-[var(--s-6)] text-center"
          >
            <div className="text-[length:var(--fs-14)] text-[color:var(--text-secondary)]">
              결과가 없습니다.
            </div>
            <div
              data-testid="search-panel-empty-hint"
              className="mt-[var(--s-2)] text-[length:var(--fs-12)] text-[color:var(--text-muted)]"
            >
              {emptyStateHint(trimmed)}
            </div>
          </div>
        ) : (
          <ul data-testid="search-panel-result-list">
            {results.map((r) => (
              <ResultCard
                key={r.messageId}
                result={r}
                channelName={channelNameById.get(r.channelId) ?? r.channelName}
                onJump={() => onJump(r)}
              />
            ))}
            {/* FR-S09: 페이지네이션 — 더 보기(20/페이지, 최대 100). */}
            {hasNextPage ? (
              <li className="px-[var(--s-2)] py-[var(--s-3)] text-center">
                <button
                  type="button"
                  data-testid="search-panel-load-more"
                  onClick={onLoadMore}
                  // a11y nit: 페이지 로딩 중임을 SR 에 알림.
                  aria-busy={isFetchingNextPage}
                  className="text-[length:var(--fs-12)] text-[color:var(--text-muted)] underline"
                >
                  {isFetchingNextPage ? '불러오는 중…' : '더 보기'}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ResultCard({
  result,
  channelName,
  onJump,
}: {
  result: SearchResult;
  channelName: string;
  onJump: () => void;
}): JSX.Element {
  const before = result.contextBefore ?? null;
  const after = result.contextAfter ?? null;
  // a11y A-1: 결과 카드 접근명. role=button 인 div 는 내부에 block/img 를 담아
  // <button> 으로 못 바꾸므로(invalid HTML) aria-label 로 접근명을 부여한다.
  // "#채널 · 작성자 · 시각[ · 스레드 답글]: 본문평문" 형태.
  const accessibleName =
    `#${channelName} · ${result.senderName} · ${new Date(result.createdAt).toLocaleString()}` +
    `${result.inThread ? ' · 스레드 답글' : ''}: ${stripTags(result.snippet)}`;
  return (
    <li>
      <div
        data-testid={`search-card-${result.messageId}`}
        className="qf-search-overlay__result"
        role="button"
        tabIndex={0}
        aria-label={accessibleName}
        onClick={onJump}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onJump();
          }
        }}
      >
        {/* 채널 + 작성자 아바타/이름/타임스탬프 */}
        <div className="qf-search-overlay__result-ctx">
          <span data-testid="search-card-channel"># {channelName}</span>
          <span aria-hidden="true">·</span>
          {/* 이름은 텍스트로 이미 노출되며 Avatar 는 내부적으로 aria-hidden 이다. */}
          <Avatar name={result.senderName} size="xs" />
          <strong>{result.senderName}</strong>
          <span aria-hidden="true">·</span>
          <time dateTime={result.createdAt}>{new Date(result.createdAt).toLocaleString()}</time>
          {/* FR-S10: In Thread 레이블 */}
          {result.inThread ? (
            // S31 (a11y N-1): 카드 aria-label 에 이미 "스레드 답글" 이 포함돼 있어
            // 이 배지를 SR 이 또 읽으면 이중 노출이 된다. 시각 배지로만 두고 SR 에서
            // 숨긴다(aria-hidden).
            <span
              data-testid="search-card-in-thread"
              aria-hidden="true"
              className="ml-[var(--s-1)] rounded-[var(--r-xs)] bg-[var(--bg-input)] px-[var(--s-2)] text-[length:var(--fs-11)] text-[color:var(--text-secondary)]"
            >
              {IN_THREAD_LABEL}
            </span>
          ) : null}
        </div>

        {/* FR-S10: 스레드면 루트 메시지 excerpt(회색) */}
        {result.inThread && result.threadRootExcerpt ? (
          <div
            data-testid="search-card-thread-root"
            className="text-[length:var(--fs-12)] text-[color:var(--text-muted)]"
          >
            <span aria-hidden="true">↳</span>
            <span className="sr-only">원본 메시지: </span> {result.threadRootExcerpt}
          </div>
        ) : null}

        {/* FR-S06: 전 컨텍스트(회색) */}
        {before ? <ContextLine kind="before" ctx={before} /> : null}

        {/* 검색어 하이라이트 본문(최대 3줄 truncate) */}
        <p
          data-testid="search-card-preview"
          className="qf-search-overlay__result-preview line-clamp-3 [&_.qf-search-code]:rounded-[var(--r-xs)] [&_.qf-search-code]:bg-[var(--bg-panel)] [&_.qf-search-code]:px-1 [&_.qf-search-code]:font-mono"
          dangerouslySetInnerHTML={{ __html: searchSnippetHtml(result.snippet) }}
        />

        {/* FR-S06: 후 컨텍스트(회색) */}
        {after ? <ContextLine kind="after" ctx={after} /> : null}

        <span className="qf-search-overlay__jump" aria-hidden="true">
          JUMP
        </span>
      </div>
    </li>
  );
}

/**
 * FR-S06: 전/후 컨텍스트 한 줄(회색). 마스킹이면 placeholder, 아니면 서버가
 * 내려준 HTML-escaped 본문을 그대로 텍스트로 렌더(추가 escape 없음).
 */
function ContextLine({
  kind,
  ctx,
}: {
  kind: 'before' | 'after';
  ctx: NonNullable<SearchResult['contextBefore']>;
}): JSX.Element {
  const masked = ctx.masked || ctx.text === null;
  return (
    <div
      data-testid={`search-card-context-${kind}`}
      data-masked={masked ? 'true' : 'false'}
      // a11y: 마스킹된 컨텍스트는 placeholder 만 보이므로 접근명을 명시한다.
      aria-label={masked ? '접근 권한이 없는 메시지' : undefined}
      className="truncate text-[length:var(--fs-12)] text-[color:var(--text-muted)]"
    >
      {ctx.senderName ? <span className="font-medium">{ctx.senderName}: </span> : null}
      {contextDisplayText(ctx)}
    </div>
  );
}

function RecentSearchList({
  recents,
  onPick,
  onRemove,
  onClear,
}: {
  recents: string[];
  onPick: (_q: string) => void;
  onRemove: (_q: string) => void;
  onClear: () => void;
}): JSX.Element {
  // FR-S01: 최근 검색 0건이면 수식어 치트시트 카드를 노출한다.
  if (recents.length === 0) {
    return (
      <div data-testid="search-panel-cheatsheet" className="px-[var(--s-3)] py-[var(--s-4)]">
        <div className="mb-[var(--s-2)] text-[length:var(--fs-12)] text-[color:var(--text-muted)]">
          수식어로 검색을 좁혀보세요
        </div>
        <div className="qf-search-overlay__filters" role="presentation">
          {SEARCH_CHEAT_SHEET.map((item) => (
            <button
              key={item.example}
              type="button"
              data-testid={`search-panel-cheat-${item.keyPart.replace(':', '')}`}
              className="qf-search-overlay__chip"
              // S31 (a11y M-1): 키+설명을 접근명으로 명시(title 만으로는 부족).
              aria-label={`${item.keyPart} ${item.hint}`}
              title={item.hint}
              onClick={() => onPick(item.example.trim())}
            >
              <span className="qf-search-overlay__chip-key">{item.keyPart}</span>
              <span>{item.rest}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="search-panel-recents">
      <div className="flex items-center justify-between px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-11)] text-[color:var(--text-muted)]">
        <span>최근 검색</span>
        {/* FR-S11: 전체 삭제. */}
        <button
          type="button"
          data-testid="search-panel-recents-clear"
          aria-label="최근 검색 전체 삭제"
          className="underline"
          onClick={onClear}
        >
          지우기
        </button>
      </div>
      <ul>
        {recents.map((q) => (
          // a11y A-3: 키보드 포커스/Enter 동작을 위해 li onClick → button.
          <li key={q} className="flex items-center gap-[var(--s-1)] pr-[var(--s-2)]">
            <button
              type="button"
              className="qf-menu__item min-w-0 flex-1 truncate text-left"
              onClick={() => onPick(q)}
            >
              {q}
            </button>
            {/* FR-S11: 개별 삭제. */}
            <button
              type="button"
              data-testid={`search-panel-recent-remove-${q}`}
              aria-label={`최근 검색 삭제: ${q}`}
              className="shrink-0 text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
              onClick={() => onRemove(q)}
            >
              <Icon name="x" size="sm" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
