import { apiRequest } from '../../lib/api';
import type { ListThreadRepliesResponse } from '@qufox/shared-types';

/**
 * Task-014-B thread client. Same `/messages/:id/...` URL shape as
 * reactions — the message id is globally unique, channel + workspace
 * derived server-side.
 */
export function listThreadReplies(
  messageId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<ListThreadRepliesResponse> {
  const qs: string[] = [];
  if (opts.cursor) qs.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  if (typeof opts.limit === 'number') qs.push(`limit=${opts.limit}`);
  const query = qs.length ? `?${qs.join('&')}` : '';
  return apiRequest(`/messages/${messageId}/thread${query}`);
}
