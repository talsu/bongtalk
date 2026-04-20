import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Dialog, Input } from '../../design-system/primitives';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useChannelList } from '../channels/useChannels';
import { useSearch, loadRecentSearches, pushRecentSearch } from './useSearch';
import { markOnlyHtml } from './sanitize';
import type { SearchResult } from '@qufox/shared-types';

/**
 * Task-015-C: Ctrl+/ search overlay. Debounces the user's typing at
 * 300ms (anything tighter wastes round trips mid-word). Empty input
 * renders the most recent 5 searches so the user can replay a
 * previous query in one click. Result clicks navigate to
 * `/w/:slug/:channelName?msg=<id>` (reuses the 011 mention-jump
 * param so MessageList scrolls to the hit).
 */
export function SearchOverlay(): JSX.Element | null {
  const openModal = useUI((s) => s.openModal);
  const setOpenModal = useUI((s) => s.setOpenModal);
  const isOpen = openModal === 'search';

  const { slug } = useParams<{ slug: string }>();
  const { data: mine } = useMyWorkspaces();
  const activeWs = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: channelList } = useChannelList(activeWs?.id);
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

  const [rawQuery, setRawQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [recents, setRecents] = useState<string[]>(() => loadRecentSearches());

  // Refresh recents on open so reopen picks up changes from this or
  // another tab. Also resets the input each open so a stale query
  // doesn't leak across sessions.
  useEffect(() => {
    if (isOpen) {
      setRawQuery('');
      setDebounced('');
      setRecents(loadRecentSearches());
    }
  }, [isOpen]);

  // 300ms debounce.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(rawQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [rawQuery]);

  const search = useSearch({
    workspaceId: activeWs?.id ?? '',
    q: debounced,
  });
  const navigate = useNavigate();

  const results: SearchResult[] = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.results),
    [search.data],
  );

  const openResult = (r: SearchResult) => {
    if (!activeWs) return;
    const chName = channelBySlug.get(r.channelId);
    if (!chName) return;
    // Persist the actual search that yielded the click.
    setRecents(pushRecentSearch(debounced));
    setOpenModal(null);
    navigate(`/w/${activeWs.slug}/${chName}?msg=${r.messageId}`);
  };

  if (!isOpen) return null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => setOpenModal(v ? 'search' : null)}
      title="메시지 검색"
      className="max-w-2xl"
    >
      <Input
        data-testid="search-input"
        autoFocus
        placeholder="검색어 입력 (Ctrl+/로 열기)"
        value={rawQuery}
        onChange={(e) => setRawQuery(e.target.value)}
      />

      <div className="mt-3 max-h-[60vh] overflow-y-auto">
        {debounced.length === 0 ? (
          <RecentList
            recents={recents}
            onPick={(q) => setRawQuery(q)}
            onClear={() => {
              localStorage.removeItem('qufox.search.recents');
              setRecents([]);
            }}
          />
        ) : search.isLoading ? (
          <div data-testid="search-loading" className="py-6 text-center text-xs text-text-muted">
            검색 중…
          </div>
        ) : results.length === 0 ? (
          <div data-testid="search-empty" className="py-6 text-center text-xs text-text-muted">
            결과가 없습니다.
          </div>
        ) : (
          <ul data-testid="search-results" className="divide-y divide-border-subtle">
            {results.map((r) => (
              <li
                key={r.messageId}
                data-testid={`search-result-${r.messageId}`}
                className="cursor-pointer px-2 py-2 hover:bg-bg-subtle/60"
                onClick={() => openResult(r)}
              >
                <div className="flex items-baseline gap-2 text-[11px] text-text-muted">
                  <span># {channelBySlug.get(r.channelId) ?? r.channelName}</span>
                  <span>·</span>
                  <span>{r.senderName}</span>
                  <span>·</span>
                  <time>{new Date(r.createdAt).toLocaleString()}</time>
                </div>
                <p
                  className="mt-0.5 break-words text-sm text-foreground [&_mark]:bg-accent-foreground/20 [&_mark]:text-accent-foreground"
                  // Server escapes content before ts_headline so only
                  // <mark>…</mark> tags ever appear; sanitize.ts is a
                  // belt-and-suspenders pass in case anything slips.
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
    </Dialog>
  );
}

function RecentList({
  recents,
  onPick,
  onClear,
}: {
  recents: string[];
  onPick: (q: string) => void;
  onClear: () => void;
}): JSX.Element {
  if (recents.length === 0) {
    return <div className="py-6 text-center text-xs text-text-muted">검색어를 입력하세요.</div>;
  }
  return (
    <div data-testid="search-recents">
      <div className="flex items-center justify-between px-2 py-1 text-[11px] text-text-muted">
        <span>최근 검색</span>
        <button type="button" className="underline" onClick={onClear}>
          지우기
        </button>
      </div>
      <ul className="divide-y divide-border-subtle">
        {recents.map((q) => (
          <li
            key={q}
            className="cursor-pointer px-2 py-2 text-sm text-foreground hover:bg-bg-subtle/60"
            onClick={() => onPick(q)}
          >
            {q}
          </li>
        ))}
      </ul>
    </div>
  );
}
