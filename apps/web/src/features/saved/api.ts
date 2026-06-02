import { apiRequest } from '../../lib/api';
import type {
  SaveStatus,
  SavedCountResponse,
  SavedMessageDto,
  SavedMessageListResponse,
  SavedStatusBulkResponse,
  SaveToggleResponse,
} from '@qufox/shared-types';

// S51 (D10 / FR-PS-07): 개인 저장함 API 클라이언트. 모두 `/me/saved` 개인 전용 라우트.

export function listSaved(
  status: SaveStatus,
  opts: { limit?: number; before?: string } = {},
): Promise<SavedMessageListResponse> {
  const params: string[] = [`status=${status}`];
  if (typeof opts.limit === 'number') params.push(`limit=${opts.limit}`);
  if (opts.before) params.push(`before=${encodeURIComponent(opts.before)}`);
  return apiRequest(`/me/saved?${params.join('&')}`);
}

export function getSavedCount(): Promise<SavedCountResponse> {
  return apiRequest('/me/saved/count');
}

export function saveMessage(messageId: string): Promise<SaveToggleResponse> {
  return apiRequest(`/me/saved/${messageId}`, { method: 'POST' });
}

export function unsaveMessage(messageId: string): Promise<SaveToggleResponse> {
  return apiRequest(`/me/saved/${messageId}`, { method: 'DELETE' });
}

// S52 (FR-PS-08): 저장 항목의 탭(status) 이동. ★savedMessageId 는 SavedMessage.id
// (item.id) 이며 messageId(item.messageId)와 다르다 — 의도된 비대칭.
export function updateSavedStatus(
  savedMessageId: string,
  status: SaveStatus,
): Promise<SavedMessageDto> {
  return apiRequest(`/me/saved/${savedMessageId}`, {
    method: 'PATCH',
    body: { status },
  });
}

// S52 (FR-PS-13): 메시지 id 배치(≤200)에 대한 저장(어느 status 든) 여부 일괄 조회.
// 채널 진입 시 북마크 채움 상태를 1회 batch 로 seed 한다(N+1 단건 GET 금지).
export function savedStatusBulk(messageIds: string[]): Promise<SavedStatusBulkResponse> {
  return apiRequest('/me/saved/status-bulk', {
    method: 'POST',
    body: { messageIds },
  });
}
