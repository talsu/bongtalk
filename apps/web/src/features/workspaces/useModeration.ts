import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReportAction, ReportQueueFilter } from '@qufox/shared-types';
import { listAuditLogs, listReports, resolveReport } from './api';

/**
 * S64 (D12 / FR-RM11·12): 신고 큐 + 감사 로그 조회 React Query 훅.
 *
 * - 감사 로그: cursor 기반 useInfiniteQuery(action/actor 필터 키 포함).
 * - 신고 큐: filter(OPEN/ALL) 별 캐시 + 처리 mutation(처리 후 큐 무효화).
 */

const moderationKeys = {
  auditLogs: (id: string, action: string, actorId: string) =>
    ['workspaces', id, 'audit-logs', { action, actorId }] as const,
  reports: (id: string, filter: ReportQueueFilter) =>
    ['workspaces', id, 'reports', filter] as const,
};

/** FR-RM12: 감사 로그 cursor 페이지(무한 스크롤). action/actor 필터 변경 시 키가 바뀐다. */
export function useAuditLogs(
  workspaceId: string,
  filters: { action?: string; actorId?: string } = {},
) {
  const action = filters.action ?? '';
  const actorId = filters.actorId ?? '';
  return useInfiniteQuery({
    queryKey: moderationKeys.auditLogs(workspaceId, action, actorId),
    queryFn: ({ pageParam }) =>
      listAuditLogs(workspaceId, {
        cursor: pageParam,
        limit: 50,
        action: action || undefined,
        actorId: actorId || undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** FR-RM11: 신고 큐 목록(MODERATOR+). filter=OPEN(미처리) / ALL. */
export function useReports(workspaceId: string, filter: ReportQueueFilter) {
  return useQuery({
    queryKey: moderationKeys.reports(workspaceId, filter),
    queryFn: () => listReports(workspaceId, filter),
  });
}

/** FR-RM11: 신고 처리. 성공 시 OPEN/ALL 큐 + 감사 로그 캐시를 무효화한다. */
export function useResolveReport(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      reportId: string;
      action: ReportAction;
      reason?: string;
      durationSeconds?: number;
    }) =>
      resolveReport(workspaceId, input.reportId, {
        action: input.action,
        reason: input.reason,
        durationSeconds: input.durationSeconds,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'reports'] });
      qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'audit-logs'] });
    },
  });
}
