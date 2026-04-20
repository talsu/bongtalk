import { apiRequest } from '../../lib/api';
import type { SearchResponse } from '@qufox/shared-types';

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
}): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  qs.set('workspaceId', args.workspaceId);
  qs.set('q', args.q);
  if (args.channelId) qs.set('channelId', args.channelId);
  if (args.cursor) qs.set('cursor', args.cursor);
  if (typeof args.limit === 'number') qs.set('limit', String(args.limit));
  return apiRequest<SearchResponse>(`/search?${qs.toString()}`);
}
