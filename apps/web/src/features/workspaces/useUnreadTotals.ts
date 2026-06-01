import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export interface WorkspaceUnreadTotal {
  workspaceId: string;
  unreadCount: number;
  hasMention: boolean;
  // S22 (FR-RS-15): 워크스페이스 전체 멘션 합산. 서버 summarizeWorkspaceTotals
  // (UnreadWorkspaceTotal.mentionCount)가 이미 공급 — 서버 버튼 멘션 뱃지의 숫자.
  mentionCount: number;
}

/**
 * Task-018-E: server-rail unread badges. One query, one server-side
 * aggregate; renders every workspace button in the rail from a single
 * entry. Refreshed lazily on message events via the existing realtime
 * dispatcher (task-005) — when an unread bump for any channel fires,
 * the dispatcher invalidates this key too.
 */
export function useWorkspaceUnreadTotals() {
  return useQuery({
    queryKey: qk.me.unreadTotals(),
    queryFn: async () => {
      const res = await apiRequest<{ totals: WorkspaceUnreadTotal[] }>('/me/unread-totals', {
        method: 'GET',
      });
      return res.totals;
    },
    staleTime: 10_000,
  });
}
