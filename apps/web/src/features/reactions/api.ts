import { apiRequest } from '../../lib/api';

/**
 * Task-013-B reactions client. URL shape matches the API controller —
 * `/messages/:id/...` is deliberately workspace-agnostic because the
 * message id is globally unique; the server derives channel + workspace.
 */
export function addReaction(
  messageId: string,
  emoji: string,
): Promise<{ emoji: string; count: number; byMe: true }> {
  return apiRequest(`/messages/${messageId}/reactions`, {
    method: 'POST',
    body: { emoji },
  });
}

export function removeReaction(messageId: string, emoji: string): Promise<void> {
  return apiRequest(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  });
}
