import { apiRequest } from '../../lib/api';
import type {
  SaveStatus,
  SavedCountResponse,
  SavedMessageListResponse,
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
