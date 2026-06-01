import { apiRequest } from '../../lib/api';
import type {
  RecentSearchesResponse,
  SearchResponse,
  SearchSort,
  SearchSuggestResponse,
} from '@qufox/shared-types';

/**
 * Task-015-C: message search client. Snippets arrive with
 * `<mark>…</mark>` pre-wrapped by Postgres ts_headline and the
 * content already HTML-escaped server-side, so the frontend can
 * render with dangerouslySetInnerHTML without pulling DOMPurify —
 * we still run a belt-and-suspenders pass (see markOnlyHtml) to
 * drop anything that slipped past.
 */
export function searchMessages(args: {
  workspaceId: string;
  q: string;
  channelId?: string;
  cursor?: string;
  limit?: number;
  // S29 (FR-S08): 정렬 토글. 미지정 시 서버 기본(relevance).
  sort?: SearchSort;
  // S30 (FR-S06/S10): true 면 결과에 전/후 컨텍스트 + 스레드 루트 excerpt 첨부.
  withContext?: boolean;
}): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  qs.set('workspaceId', args.workspaceId);
  qs.set('q', args.q);
  if (args.channelId) qs.set('channelId', args.channelId);
  if (args.cursor) qs.set('cursor', args.cursor);
  if (typeof args.limit === 'number') qs.set('limit', String(args.limit));
  if (args.sort) qs.set('sort', args.sort);
  if (args.withContext) qs.set('withContext', 'true');
  return apiRequest<SearchResponse>(`/search?${qs.toString()}`);
}

/**
 * S30 (FR-S07): 서버측 최근 검색어. Redis `search:recent:{userId}` 를
 * newest-first 로 돌려줍니다. localStorage recents 와 별개의 동기화 소스 —
 * 결과 패널 빈 상태에서 노출합니다.
 */
export function fetchRecentSearches(): Promise<RecentSearchesResponse> {
  return apiRequest<RecentSearchesResponse>('/search/recent');
}

/**
 * S31 (FR-S11): 최근 검색어 개별 삭제. 엔트리는 공백/특수문자를 포함할 수
 * 있어 query string 으로 전달합니다(서버는 LREM 으로 해당 엔트리만 제거).
 */
export function deleteRecentSearch(entry: string): Promise<void> {
  return apiRequest<void>(`/search/recent?q=${encodeURIComponent(entry)}`, { method: 'DELETE' });
}

/** S31 (FR-S11): 최근 검색어 전체 삭제(서버 Redis DEL). */
export function clearRecentSearches(): Promise<void> {
  return apiRequest<void>('/search/recent', { method: 'DELETE' });
}

/**
 * S31 (FR-S02): 수식어 자동완성 후보. from:/in: 타이핑 중 워크스페이스 가시
 * 채널명 + 멤버 username prefix-match. has: 는 클라이언트 정적 옵션이라 호출
 * 불필요.
 */
export function fetchSearchSuggest(args: {
  workspaceId: string;
  q: string;
  limit?: number;
}): Promise<SearchSuggestResponse> {
  const qs = new URLSearchParams();
  qs.set('workspaceId', args.workspaceId);
  qs.set('q', args.q);
  if (typeof args.limit === 'number') qs.set('limit', String(args.limit));
  return apiRequest<SearchSuggestResponse>(`/search/suggest?${qs.toString()}`);
}
