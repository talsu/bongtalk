import { apiRequest } from '../../lib/api';
import type {
  ListMessagesQuery,
  ListMessagesResponse,
  MessageDto,
  SendMessageRequest,
  UpdateMessageRequest,
} from '@qufox/shared-types';

function toQuery(q: Partial<ListMessagesQuery>): string {
  const params: string[] = [];
  if (q.before) params.push(`before=${encodeURIComponent(q.before)}`);
  if (q.after) params.push(`after=${encodeURIComponent(q.after)}`);
  if (q.around) params.push(`around=${encodeURIComponent(q.around)}`);
  if (typeof q.limit === 'number') params.push(`limit=${q.limit}`);
  if (q.includeDeleted) params.push(`includeDeleted=true`);
  return params.length ? `?${params.join('&')}` : '';
}

export function listMessages(
  wsId: string,
  channelId: string,
  query: Partial<ListMessagesQuery> = {},
): Promise<ListMessagesResponse> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/messages${toQuery(query)}`);
}

export function sendMessage(
  wsId: string,
  channelId: string,
  input: SendMessageRequest,
  idempotencyKey: string,
): Promise<{ message: MessageDto; replayed: boolean }> {
  return apiRequestRaw(`/workspaces/${wsId}/channels/${channelId}/messages`, {
    method: 'POST',
    body: input,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function updateMessage(
  wsId: string,
  channelId: string,
  msgId: string,
  input: UpdateMessageRequest,
): Promise<{ message: MessageDto }> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/messages/${msgId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteMessage(wsId: string, channelId: string, msgId: string): Promise<void> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/messages/${msgId}`, {
    method: 'DELETE',
  });
}

/**
 * Variant of apiRequest that reads the `Idempotency-Replayed` header. We need
 * that flag so the client can distinguish "our POST was the one that created
 * the row" from "the server already had this row". The shared `apiRequest`
 * only returns JSON — this wrapper returns both body and a replay flag.
 */
async function apiRequestRaw(
  path: string,
  opts: {
    method: string;
    body: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ message: MessageDto; replayed: boolean }> {
  const { getAccessToken, onForcedLogout } = await import('../../lib/api');
  const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '/api';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };
  const token = getAccessToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method,
    headers,
    credentials: 'include',
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody?.message ?? `http ${res.status}`) as Error & {
      errorCode?: string;
      status?: number;
    };
    err.errorCode = errBody?.errorCode;
    err.status = res.status;
    throw err;
  }
  // note: onForcedLogout is imported only so the bundler pulls the refresh
  // logic in for retry — the POST path delegates 401 handling to apiRequest's
  // retry for the following list refetch.
  void onForcedLogout;
  const body = await res.json();
  return {
    message: body.message,
    replayed: res.headers.get('idempotency-replayed') === 'true',
  };
}
