import { apiRequest } from '../../lib/api';
import { SNOOZE_MINUTES } from '@qufox/shared-types';
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

// S53 (FR-PS-09/10): 저장 항목 리마인더 설정/취소. reminderAt 은 UTC ISO 문자열
// (클라이언트가 User.timezone/브라우저 tz 로 프리셋을 계산한 절대 시각). null 이면
// 취소(서버가 reminderFiredAt/snoozedUntil 도 클리어).
export function setReminder(
  savedMessageId: string,
  reminderAt: string | null,
): Promise<SavedMessageDto> {
  return apiRequest(`/me/saved/${savedMessageId}`, {
    method: 'PATCH',
    body: { reminderAt },
  });
}

// S53 (FR-PS-10): "10분 후 다시 알림". 현재는 단일 옵션(10분).
export function snoozeReminder(savedMessageId: string): Promise<SavedMessageDto> {
  return apiRequest(`/me/saved/${savedMessageId}/snooze`, {
    method: 'PATCH',
    body: { snoozeMinutes: SNOOZE_MINUTES },
  });
}

// S53 (FR-PS-11): 놓친 리마인더 목록(재접속 표시). status 탭 무시, COMPLETED 제외.
export function listOverdueReminders(): Promise<SavedMessageListResponse> {
  return apiRequest('/me/saved?overdueReminder=true&limit=50');
}
