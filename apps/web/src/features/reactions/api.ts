import type { ListReactionUsersResponse } from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';

/**
 * S39 (FR-RE01) reactions client. URL shape matches the API controller —
 * `/messages/:id/...` is deliberately workspace-agnostic because the
 * message id is globally unique; the server derives channel + workspace.
 *
 * POST is a single-call **toggle**: 서버가 내 (messageId,userId,emoji) 행이
 * 있으면 제거, 없으면 추가하고 항상 200 + 현재 집계({ emoji, count, byMe })를
 * 돌려준다. 따라서 클라이언트는 추가/제거를 구분할 필요 없이 이 한 번만 호출한다.
 */
export function toggleReaction(
  messageId: string,
  emoji: string,
): Promise<{ emoji: string; count: number; byMe: boolean }> {
  return apiRequest(`/messages/${messageId}/reactions`, {
    method: 'POST',
    body: { emoji },
  });
}

/**
 * S40 (FR-RE05): 한 이모지에 반응한 **전체** reactor 목록을 cursor 페이지네이션으로
 * 가져온다(기본 50/최대 100). 반응 칩을 눌렀을 때 전원을 무한 스크롤로 펼치는
 * reactor 모달이 소비한다. `cursor` 는 직전 응답의 opaque nextCursor 를 그대로 전달.
 */
export function fetchReactionUsers(
  messageId: string,
  emoji: string,
  opts?: { cursor?: string; limit?: number },
): Promise<ListReactionUsersResponse> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiRequest(
    `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users${qs ? `?${qs}` : ''}`,
  );
}

/**
 * S40 (FR-RE08): OWNER/ADMIN 이 특정 사용자의 한 이모지 반응을 제거한다(타인 모더레이션).
 * 자기 자신을 target 으로 호출하면 자기 반응 제거(toggle off 와 동치)다. 204(본문 없음).
 */
export function removeReactionByUser(
  messageId: string,
  emoji: string,
  targetUserId: string,
): Promise<void> {
  return apiRequest(
    `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users/${targetUserId}`,
    { method: 'DELETE' },
  );
}

/**
 * S40 (FR-RE09): OWNER/ADMIN 이 메시지의 **모든** 반응을 일괄 삭제한다. 204(본문 없음).
 * 성공 시 서버가 reaction:cleared 를 채널 룸으로 fanout 하므로, 호출측은 별도
 * 캐시 패치 없이 dispatcher 의 full-clear 에 맡긴다.
 */
export function clearAllReactions(messageId: string): Promise<void> {
  return apiRequest(`/messages/${messageId}/reactions`, { method: 'DELETE' });
}
