import { apiRequest } from '../../lib/api';
import type {
  ListMessagesQuery,
  ListMessagesResponse,
  ListPinsResponse,
  MessageDto,
  PinMessageResponse,
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

/**
 * Route selector: `null` wsId → Global DM endpoint at
 * `/me/dms/:channelId/messages`. This lets zero-workspace users
 * (friends-only signup flow) send + receive DMs without pretending
 * to be a member of some host workspace.
 */
function basePath(wsId: string | null, channelId: string): string {
  return wsId === null
    ? `/me/dms/${channelId}/messages`
    : `/workspaces/${wsId}/channels/${channelId}/messages`;
}

export function listMessages(
  wsId: string | null,
  channelId: string,
  query: Partial<ListMessagesQuery> = {},
): Promise<ListMessagesResponse> {
  return apiRequest(`${basePath(wsId, channelId)}${toQuery(query)}`);
}

/**
 * S03 (FR-MSG-04): the clientNonce is the SINGLE identifier — it is sent both
 * as the POST body `nonce` (echoed on message:created for the optimistic swap)
 * AND as the `Idempotency-Key` header (server-side dedupe). The caller never
 * mints a separate tempId.
 */
export function sendMessage(
  wsId: string | null,
  channelId: string,
  input: SendMessageRequest,
  clientNonce: string,
): Promise<{ message: MessageDto; replayed: boolean }> {
  return apiRequestRaw(basePath(wsId, channelId), {
    method: 'POST',
    body: { ...input, nonce: clientNonce },
    headers: { 'Idempotency-Key': clientNonce },
  });
}

export function updateMessage(
  wsId: string | null,
  channelId: string,
  msgId: string,
  input: UpdateMessageRequest,
): Promise<{ message: MessageDto }> {
  return apiRequest(`${basePath(wsId, channelId)}/${msgId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteMessage(
  wsId: string | null,
  channelId: string,
  msgId: string,
): Promise<void> {
  return apiRequest(`${basePath(wsId, channelId)}/${msgId}`, {
    method: 'DELETE',
  });
}

// task-045 iter1: 메시지 pin / unpin / list pinned. DM 채널에는
// pinned messages 가 의미 없도록 BE 가 wsId 기반 routing 만 처리 —
// FE 도 wsId=null 케이스에서는 호출 자체를 막아야 합니다 (호출 시
// 404 반환). 호출자가 OWNER/ADMIN 권한 보유 여부도 책임집니다.
export function pinMessage(
  wsId: string,
  channelId: string,
  msgId: string,
): Promise<PinMessageResponse> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/messages/${msgId}/pin`, {
    method: 'POST',
  });
}

export function unpinMessage(
  wsId: string,
  channelId: string,
  msgId: string,
): Promise<{ id: string; pinnedAt: string | null; pinnedBy: string | null }> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/messages/${msgId}/pin`, {
    method: 'DELETE',
  });
}

export function listPins(wsId: string, channelId: string): Promise<ListPinsResponse> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/messages/pins`);
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
