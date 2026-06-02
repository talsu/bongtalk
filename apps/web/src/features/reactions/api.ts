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
