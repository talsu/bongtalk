import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult, SearchSuggestResponse } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { useChannelList } from '../channels/useChannels';
import { useUI } from '../../stores/ui-store';
import { useSearch, pushRecentSearch, useRecentSearches } from './useSearch';
import { fetchSearchSuggest } from './api';
import { searchSnippetHtml } from './sanitize';
import { isSearchQueryAllowed } from './searchQueryGate';
import {
  detectActiveModifierToken,
  completeModifierToken,
  HAS_STATIC_OPTIONS,
  type ActiveModifierToken,
} from './suggestToken';
import { nextHighlightIndex, optionId, activeDescendantId } from './comboboxNav';
import { SEARCH_CHEAT_SHEET } from './searchResultView';
import { cn } from '../../lib/cn';

/**
 * Inline message search lives IN the topbar input — no modal, no
 * popover dismissal wobble. Typing fires a 300 ms debounce; as soon
 * as the user pauses, the results dropdown slides in below the input.
 *
 * S31 (FR-S01/S02): 드롭다운은 3분기로 동작한다.
 *   - cheatsheet: 빈 입력 + 최근검색 0건 → 수식어 치트시트 카드.
 *   - suggest   : 현재 토큰이 from:/in:/has: 수식어 → 인라인 자동완성.
 *   - results   : 일반 검색 결과(또는 빈 입력 + 최근검색 ≥1건 → 최근 목록).
 * combobox ARIA(role/aria-expanded/aria-activedescendant) + 키보드 도달을
 * 모든 분기에 적용한다.
 *
 * Keyboard surface:
 *   - Ctrl/Cmd + /  → focus this input
 *   - Escape         → blur + close dropdown
 *   - ArrowDown / Up → move active option highlight
 *   - Enter          → select active option / open the highlighted result
 */

const QUERY_DEBOUNCE_MS = 300;
const FOCUS_EVENT = 'qufox.search.focus';
const LISTBOX_ID = 'qf-search-listbox';
const SUGGEST_DEBOUNCE_MS = 180;
const SUGGEST_LIMIT = 6;

type SuggestItem =
  | { kind: 'channel'; id: string; label: string; insert: string }
  | { kind: 'user'; id: string; label: string; insert: string }
  | { kind: 'has'; id: string; label: string; insert: string };

export function SearchInput({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}): JSX.Element {
  const navigate = useNavigate();
  const openSearchPanel = useUI((s) => s.openSearchPanel);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [rawQuery, setRawQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // S31 (FR-S11): 서버/로컬 병합 최근 검색 — 포커스 시에만 fetch.
  const { recents, removeOne, clearAll } = useRecentSearches({ enabled: focused });

  const { data: channelList } = useChannelList(workspaceId);
  const channelBySlug = useMemo(() => {
    const map = new Map<string, string>();
    if (!channelList) return map;
    const flat = [
      ...channelList.uncategorized,
      ...channelList.categories.flatMap((c) => c.channels),
    ];
    for (const c of flat) map.set(c.id, c.name);
    return map;
  }, [channelList]);

  // 300 ms debounce for the result query.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(rawQuery.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  // S31 (FR-S02): 현재(활성) 토큰이 from:/in:/has: 수식어인지 즉시 감지(미디바운스
  // — 토큰 구조 변화는 매 키 입력마다 의미가 있음). suggest API 호출은 debounce.
  const activeToken = useMemo(() => detectActiveModifierToken(rawQuery), [rawQuery]);
  const [suggestPrefix, setSuggestPrefix] = useState('');
  useEffect(() => {
    if (!activeToken || activeToken.kind === 'has') {
      setSuggestPrefix('');
      return;
    }
    const id = setTimeout(() => setSuggestPrefix(activeToken.prefix), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [activeToken]);

  const suggestQuery = useQuery({
    queryKey: ['search', 'suggest', workspaceId, activeToken?.kind ?? null, suggestPrefix],
    queryFn: () => fetchSearchSuggest({ workspaceId, q: suggestPrefix, limit: SUGGEST_LIMIT }),
    enabled:
      !!workspaceId &&
      !!activeToken &&
      activeToken.kind !== 'has' &&
      suggestPrefix.trim().length > 0,
    staleTime: 10_000,
  });

  const suggestItems = useMemo(
    () => buildSuggestItems(activeToken, suggestQuery.data),
    [activeToken, suggestQuery.data],
  );

  // S31 (FR-S13): 게이트 통과한 쿼리만 서버로(useSearch enabled 가 재차 방어).
  // NIT4: suggest 모드(활성 토큰 존재)면 결과 드롭다운을 띄우지 않으므로 결과
  // 쿼리를 비활성화해 불필요한 요청을 막는다.
  const search = useSearch({ workspaceId, q: debounced, enabled: activeToken === null });
  const results: SearchResult[] = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.results),
    [search.data],
  );

  // 드롭다운 분기 결정. suggest 가 results 보다 우선(활성 토큰이 있으면).
  const showSuggest = focused && activeToken !== null;
  const showRecentsOrCheat = focused && !showSuggest && debounced.length === 0;
  const showCheatSheet = showRecentsOrCheat && recents.length === 0;
  const showResults = focused && !showSuggest && debounced.length > 0;

  // 키보드 nav 대상 항목 수(suggest 또는 results 분기에서만 이동 가능).
  const navCount = showSuggest ? suggestItems.length : showResults ? results.length : 0;

  // 항목/분기 변경 시 highlight 를 범위 안으로.
  useEffect(() => {
    setHighlight((i) => (i >= navCount ? 0 : i));
  }, [navCount]);

  // 하이라이트된 결과를 viewport 안으로 스크롤.
  const resultRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  useEffect(() => {
    if (!showResults) return;
    const r = results[highlight];
    if (!r) return;
    const el = resultRefs.current.get(r.messageId);
    // scrollIntoView 미구현 환경(jsdom/구형) 가드.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [highlight, results, showResults]);

  // Global Ctrl/Cmd + / focus handoff.
  useEffect(() => {
    const onFocusReq = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(FOCUS_EVENT, onFocusReq);
    return () => window.removeEventListener(FOCUS_EVENT, onFocusReq);
  }, []);

  // Outside-click dismiss.
  useEffect(() => {
    if (!focused) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setFocused(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [focused]);

  const openResult = (r: SearchResult): void => {
    const chName = channelBySlug.get(r.channelId);
    if (!chName) return;
    pushRecentSearch(debounced);
    setFocused(false);
    setRawQuery('');
    setDebounced('');
    inputRef.current?.blur();
    navigate(`/w/${workspaceSlug}/${chName}?msg=${r.messageId}`);
  };

  const pickSuggest = (item: SuggestItem): void => {
    if (!activeToken) return;
    const next = completeModifierToken(rawQuery, activeToken.start, activeToken.key, item.insert);
    setRawQuery(next);
    inputRef.current?.focus();
  };

  const prefillCheat = (example: string): void => {
    setRawQuery(example);
    inputRef.current?.focus();
  };

  // S31 (a11y S-2): 최근 검색 개별/전체 삭제 후 포커스가 사라진 버튼과 함께
  // 소실되지 않도록 input 으로 되돌린다.
  const removeRecent = (entry: string): void => {
    removeOne(entry);
    inputRef.current?.focus();
  };
  const clearRecent = (): void => {
    clearAll();
    inputRef.current?.focus();
  };

  const runPanelSearch = (): void => {
    const q = debounced.trim();
    if (!isSearchQueryAllowed(q)) return;
    pushRecentSearch(q);
    setFocused(false);
    inputRef.current?.blur();
    openSearchPanel(q);
  };

  const dropdownOpen = focused;
  const activeDescendant = showSuggest
    ? activeDescendantId('suggest', highlight, suggestItems.length)
    : showResults
      ? activeDescendantId('result', highlight, results.length)
      : undefined;

  // S31 (a11y B-1/B-2): combobox 의 aria-controls 는 실제 role=listbox 요소를
  // 가리켜야 한다. listbox 는 suggest 옵션이 있을 때와 결과 옵션이 있을 때만
  // 렌더된다(치트시트/최근/로딩/빈결과 분기엔 listbox 가 없다). listbox 가 없는
  // 분기에서는 aria-controls 를 dangling 시키지 않고 aria-expanded=false 로 둔다.
  const hasListbox =
    dropdownOpen &&
    ((showSuggest && suggestItems.length > 0) || (showResults && results.length > 0));

  // S31 (a11y S-1): SR 전용 상태 1줄. "검색 중"/"결과 없음"/"N건"/"N개 제안".
  const dropdownStatus = !dropdownOpen
    ? ''
    : showSuggest
      ? suggestQuery.isLoading
        ? '제안 불러오는 중'
        : suggestItems.length === 0
          ? '제안이 없습니다'
          : `${suggestItems.length}개 제안`
      : showResults
        ? search.isLoading
          ? '검색 중'
          : results.length === 0
            ? '결과 없음'
            : `${results.length}건의 검색 결과`
        : '';

  return (
    <div ref={rootRef} className="relative">
      <label className="relative block">
        <Icon
          name="search"
          size="sm"
          className="pointer-events-none absolute left-[var(--s-3)] top-1/2 -translate-y-1/2 text-text-muted"
        />
        <input
          ref={inputRef}
          data-testid="topbar-search"
          type="text"
          role="combobox"
          // S31 (a11y B-1): listbox 가 실제 렌더된 분기에서만 expanded=true +
          // aria-controls 를 건다. 그 외(치트시트/최근/로딩/빈결과)는 팝업은
          // 떠 있지만 listbox 가 없으므로 dangling aria-controls 를 피한다.
          aria-expanded={hasListbox}
          aria-haspopup="listbox"
          aria-controls={hasListbox ? LISTBOX_ID : undefined}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (native.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape') {
              e.stopPropagation();
              // S31 (a11y N-3): Esc 는 드롭다운만 닫고 input 포커스는 유지한다
              // (APG combobox 권장 — blur 로 포커스를 잃지 않게).
              setFocused(false);
              return;
            }
            if (!dropdownOpen) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((i) => nextHighlightIndex(i, navCount, 'down'));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((i) => nextHighlightIndex(i, navCount, 'up'));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (showSuggest && suggestItems[highlight]) {
                pickSuggest(suggestItems[highlight]);
              } else if (showResults && results[highlight]) {
                openResult(results[highlight]);
              } else if (debounced.trim().length > 0) {
                runPanelSearch();
              }
            }
          }}
          placeholder="검색 (Ctrl+/)"
          aria-label="메시지 검색"
          autoComplete="off"
          className="qf-input h-topbar-search w-topbar-search pl-[var(--s-8)] text-[length:var(--fs-13)]"
        />
      </label>

      {dropdownOpen ? (
        <div
          data-testid="search-dropdown"
          className={cn(
            'absolute right-0 top-full z-[var(--z-dropdown)] mt-1 w-96',
            'max-h-[60vh] overflow-y-auto',
            'rounded-[var(--r-md)] border border-border-subtle bg-bg-surface shadow-[var(--elev-3)]',
          )}
        >
          {/* S31 (a11y S-1): 드롭다운 상태를 SR 에 1줄로 통지(시각 숨김). */}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="search-status"
          >
            {dropdownStatus}
          </span>
          {showSuggest ? (
            <SuggestOptions
              items={suggestItems}
              highlight={highlight}
              isLoading={suggestQuery.isLoading}
              onHover={setHighlight}
              onPick={pickSuggest}
            />
          ) : showCheatSheet ? (
            <CheatSheetCard onPick={prefillCheat} />
          ) : showRecentsOrCheat ? (
            <RecentList
              recents={recents}
              onPick={prefillCheat}
              onRemove={removeRecent}
              onClear={clearRecent}
            />
          ) : search.isLoading ? (
            <div
              data-testid="search-loading"
              className="px-[var(--s-4)] py-[var(--s-5)] text-center text-[length:var(--fs-11)] text-text-muted"
            >
              검색 중…
            </div>
          ) : results.length === 0 ? (
            <div
              data-testid="search-empty"
              className="px-[var(--s-4)] py-[var(--s-5)] text-center text-[length:var(--fs-11)] text-text-muted"
            >
              결과가 없습니다.
            </div>
          ) : (
            <>
              <ul
                id={LISTBOX_ID}
                data-testid="search-results"
                role="listbox"
                aria-label="검색 결과"
                className="divide-y divide-border-subtle"
              >
                {results.map((r, i) => (
                  <li
                    key={r.messageId}
                    id={optionId('result', i)}
                    role="option"
                    aria-selected={i === highlight}
                    ref={(el) => {
                      if (el) resultRefs.current.set(r.messageId, el);
                      else resultRefs.current.delete(r.messageId);
                    }}
                    data-testid={`search-result-${r.messageId}`}
                    data-highlighted={i === highlight ? 'true' : 'false'}
                    className={cn(
                      'cursor-pointer px-[var(--s-3)] py-[var(--s-3)]',
                      // S31 (a11y M-3): highlight 를 색만으로 표시하지 않는다 —
                      // 좌측 보더 + 본문 굵게로 비색 단서를 추가한다.
                      i === highlight
                        ? 'border-l-2 border-accent bg-bg-muted'
                        : 'border-l-2 border-transparent hover:bg-bg-muted',
                    )}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => openResult(r)}
                  >
                    <div className="flex items-baseline gap-2 text-[length:var(--fs-11)] text-text-muted">
                      <span># {channelBySlug.get(r.channelId) ?? r.channelName}</span>
                      <span>·</span>
                      <span>{r.senderName}</span>
                      <span>·</span>
                      <time>{new Date(r.createdAt).toLocaleString()}</time>
                    </div>
                    <p
                      className={cn(
                        'mt-0.5 break-words text-[length:var(--fs-14)] text-foreground [&_mark]:rounded-[var(--r-xs)] [&_mark]:bg-mention [&_mark]:px-1 [&_mark]:text-text-strong [&_.qf-mention]:text-[color:var(--a-200)] [&_.qf-channel-ref]:text-[color:var(--link)] [&_.qf-search-code]:rounded-[var(--r-xs)] [&_.qf-search-code]:bg-bg-subtle [&_.qf-search-code]:px-1 [&_.qf-search-code]:font-mono',
                        i === highlight ? 'font-semibold' : null,
                      )}
                      dangerouslySetInnerHTML={{ __html: searchSnippetHtml(r.snippet) }}
                    />
                  </li>
                ))}
              </ul>
              {/* S31 (a11y B-2): "더 보기" 는 role=option 이 아니므로 listbox(<ul>)
                  바깥에 둔다(listbox 자식은 option 만 허용). */}
              {search.hasNextPage ? (
                <div className="px-2 py-3 text-center">
                  <button
                    data-testid="search-load-more"
                    type="button"
                    onClick={() => search.fetchNextPage()}
                    className="text-[length:var(--fs-12)] text-text-muted underline"
                  >
                    {search.isFetchingNextPage ? '불러오는 중…' : '더 보기'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * S31 (FR-S02): 활성 토큰 + suggest API 응답을 통합 옵션 리스트로 변환.
 * has: 는 정적 옵션(image/file/link)을 prefix 로 필터.
 */
function buildSuggestItems(
  token: ActiveModifierToken | null,
  data: SearchSuggestResponse | undefined,
): SuggestItem[] {
  if (!token) return [];
  if (token.kind === 'has') {
    return HAS_STATIC_OPTIONS.filter((o) => o.startsWith(token.prefix.toLowerCase())).map((o) => ({
      kind: 'has' as const,
      id: o,
      label: o,
      insert: o,
    }));
  }
  if (!data) return [];
  if (token.kind === 'channel') {
    return data.channels.map((c) => ({
      kind: 'channel' as const,
      id: c.id,
      label: `#${c.name}`,
      insert: `#${c.name}`,
    }));
  }
  return data.users.map((u) => ({
    kind: 'user' as const,
    id: u.id,
    label: `@${u.username}`,
    insert: `@${u.username}`,
  }));
}

function SuggestOptions({
  items,
  highlight,
  isLoading,
  onHover,
  onPick,
}: {
  items: SuggestItem[];
  highlight: number;
  isLoading: boolean;
  onHover: (_i: number) => void;
  onPick: (_item: SuggestItem) => void;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <div
        data-testid="search-suggest-empty"
        className="px-[var(--s-4)] py-[var(--s-4)] text-center text-[length:var(--fs-11)] text-text-muted"
      >
        {isLoading ? '제안 불러오는 중…' : '제안이 없습니다.'}
      </div>
    );
  }
  return (
    <ul id={LISTBOX_ID} data-testid="search-suggest" role="listbox" aria-label="수식어 자동완성">
      {items.map((item, i) => (
        <li
          key={`${item.kind}-${item.id}`}
          id={optionId('suggest', i)}
          role="option"
          aria-selected={i === highlight}
          data-testid={`search-suggest-${i}`}
          data-highlighted={i === highlight ? 'true' : 'false'}
          className={cn(
            'flex cursor-pointer items-center gap-[var(--s-2)] px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-13)] text-foreground',
            i === highlight ? 'bg-bg-muted' : 'hover:bg-bg-muted',
          )}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <Icon
            name={item.kind === 'channel' ? 'hash' : item.kind === 'user' ? 'user' : 'file'}
            size="sm"
          />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * S31 (FR-S01): 최근검색 0건 첫 포커스 시 수식어 치트시트 카드. DS
 * qf-search-overlay__filters / __chip / __chip-key 구조로 렌더하고 클릭 시
 * 입력창에 프리필합니다.
 */
function CheatSheetCard({ onPick }: { onPick: (_example: string) => void }): JSX.Element {
  return (
    <div data-testid="search-cheatsheet" className="px-[var(--s-1)] py-[var(--s-2)]">
      <div className="px-[var(--s-3)] py-[var(--s-1)] text-[length:var(--fs-11)] text-text-muted">
        수식어로 검색을 좁혀보세요
      </div>
      <div className="qf-search-overlay__filters" role="presentation">
        {SEARCH_CHEAT_SHEET.map((item) => (
          <button
            key={item.example}
            type="button"
            data-testid={`search-cheat-${item.keyPart.replace(':', '')}`}
            className="qf-search-overlay__chip"
            // S31 (a11y M-1): title 만으로는 SR 에 hint 가 안 읽힐 수 있어
            // 키+설명을 접근명으로 명시한다.
            aria-label={`${item.keyPart} ${item.hint}`}
            title={item.hint}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item.example);
            }}
          >
            <span className="qf-search-overlay__chip-key">{item.keyPart}</span>
            <span>{item.rest}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecentList({
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
  return (
    <div data-testid="search-recents">
      <div className="flex items-center justify-between px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted">
        <span>최근 검색</span>
        <button
          type="button"
          aria-label="최근 검색 전체 삭제"
          className="underline"
          onMouseDown={(e) => {
            e.preventDefault();
            onClear();
          }}
        >
          지우기
        </button>
      </div>
      <div>
        {recents.map((q) => (
          <div key={q} className="qf-menu__item flex items-center justify-between gap-[var(--s-2)]">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(q);
              }}
            >
              {q}
            </button>
            <button
              type="button"
              data-testid={`search-recent-remove-${q}`}
              aria-label={`최근 검색 삭제: ${q}`}
              className="shrink-0 text-text-muted hover:text-foreground"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(q);
              }}
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dispatch from global shortcut handler to focus the input. */
export function emitFocusSearch(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}
