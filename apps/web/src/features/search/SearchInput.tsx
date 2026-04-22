import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SearchResult } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { useChannelList } from '../channels/useChannels';
import { useSearch, loadRecentSearches, pushRecentSearch } from './useSearch';
import { markOnlyHtml } from './sanitize';
import { cn } from '../../lib/cn';

/**
 * Inline message search lives IN the topbar input — no modal, no
 * popover dismissal wobble. Typing fires a 300 ms debounce; as soon
 * as the user pauses, the results dropdown slides in below the input.
 *
 * Keyboard surface:
 *   - Ctrl/Cmd + /  → focus this input (dispatched via
 *                     `window.qufox.focusSearch` CustomEvent so the
 *                     global shortcut handler can reach the mounted
 *                     instance without lifting state into a store)
 *   - Escape         → blur + close dropdown
 *   - ArrowDown / Up → move result highlight
 *   - Enter          → open the highlighted result (or the first one)
 */

const QUERY_DEBOUNCE_MS = 300;
const FOCUS_EVENT = 'qufox.search.focus';

export function SearchInput({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}): JSX.Element {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [rawQuery, setRawQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState<string[]>(() => loadRecentSearches());

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

  // 300 ms debounce. The user request: trigger search when typing
  // pauses past the debounce window; trim whitespace so trailing
  // spaces don't refetch.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(rawQuery.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  const search = useSearch({ workspaceId, q: debounced });
  const results: SearchResult[] = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.results),
    [search.data],
  );

  // Keep highlight within bounds when results change.
  useEffect(() => {
    if (highlight >= results.length) setHighlight(0);
  }, [results.length, highlight]);

  // Global Ctrl/Cmd + / focus handoff from the shortcut handler.
  useEffect(() => {
    const onFocusReq = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(FOCUS_EVENT, onFocusReq);
    return () => window.removeEventListener(FOCUS_EVENT, onFocusReq);
  }, []);

  // Outside-click dismiss — the input stays mounted, we only collapse
  // the dropdown. Input's own onBlur would fire too eagerly when
  // clicking a result, so we watch the document instead.
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
    setRecents(pushRecentSearch(debounced));
    setFocused(false);
    setRawQuery('');
    setDebounced('');
    inputRef.current?.blur();
    navigate(`/w/${workspaceSlug}/${chName}?msg=${r.messageId}`);
  };

  const dropdownOpen = focused;
  const showRecents = debounced.length === 0;

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
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          onFocus={() => {
            setFocused(true);
            setRecents(loadRecentSearches());
          }}
          onKeyDown={(e) => {
            // IME guard for consistency with other Enter surfaces.
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (native.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape') {
              setFocused(false);
              inputRef.current?.blur();
              return;
            }
            if (!dropdownOpen) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (results[highlight]) openResult(results[highlight]);
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
            'absolute right-0 top-full z-dropdown mt-1 w-96',
            'max-h-[60vh] overflow-y-auto',
            'rounded-[var(--r-md)] border border-border-subtle bg-bg-elevated shadow-[var(--elev-3)]',
          )}
        >
          {showRecents ? (
            <RecentList
              recents={recents}
              onPick={(q) => {
                setRawQuery(q);
                setDebounced(q);
                inputRef.current?.focus();
              }}
              onClear={() => {
                localStorage.removeItem('qufox.search.recents');
                setRecents([]);
              }}
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
            <ul data-testid="search-results" className="divide-y divide-border-subtle">
              {results.map((r, i) => (
                <li
                  key={r.messageId}
                  data-testid={`search-result-${r.messageId}`}
                  data-highlighted={i === highlight ? 'true' : 'false'}
                  className={cn(
                    'cursor-pointer px-[var(--s-3)] py-[var(--s-3)]',
                    i === highlight ? 'bg-bg-hover' : 'hover:bg-bg-hover',
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
                    className="mt-0.5 break-words text-[length:var(--fs-14)] text-text [&_mark]:rounded-[var(--r-xs)] [&_mark]:bg-mention [&_mark]:px-1 [&_mark]:text-text-strong"
                    dangerouslySetInnerHTML={{ __html: markOnlyHtml(r.snippet) }}
                  />
                </li>
              ))}
              {search.hasNextPage ? (
                <li className="px-2 py-3 text-center">
                  <button
                    data-testid="search-load-more"
                    type="button"
                    onClick={() => search.fetchNextPage()}
                    className="text-xs text-text-muted underline"
                  >
                    {search.isFetchingNextPage ? '불러오는 중…' : '더 보기'}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RecentList({
  recents,
  onPick,
  onClear,
}: {
  recents: string[];
  onPick: (_q: string) => void;
  onClear: () => void;
}): JSX.Element {
  if (recents.length === 0) {
    return (
      <div className="px-[var(--s-4)] py-[var(--s-5)] text-center text-[length:var(--fs-11)] text-text-muted">
        검색어를 입력하세요.
      </div>
    );
  }
  return (
    <div data-testid="search-recents">
      <div className="flex items-center justify-between px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted">
        <span>최근 검색</span>
        <button type="button" className="underline" onClick={onClear}>
          지우기
        </button>
      </div>
      <ul>
        {recents.map((q) => (
          <li
            key={q}
            className="qf-menu__item"
            onMouseDown={(e) => {
              // mousedown over onClick so the blur doesn't close the
              // dropdown before the pick fires.
              e.preventDefault();
              onPick(q);
            }}
          >
            {q}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Dispatch from global shortcut handler to focus the input. */
export function emitFocusSearch(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}
