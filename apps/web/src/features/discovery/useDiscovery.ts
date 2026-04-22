import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveryPage, WorkspaceCategory } from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';

export function useDiscoverWorkspaces(params: { category?: WorkspaceCategory | ''; q?: string }) {
  const cat = params.category ?? '';
  const q = (params.q ?? '').trim();
  return useQuery<DiscoveryPage>({
    queryKey: ['discovery', cat, q],
    queryFn: () => {
      const url = `/workspaces/discover?category=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}&limit=50`;
      return apiRequest<DiscoveryPage>(url);
    },
    staleTime: 15_000,
  });
}

export function useJoinWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    { workspaceId: string; alreadyMember: boolean },
    Error,
    { workspaceId: string }
  >({
    mutationFn: (body) => apiRequest(`/workspaces/${body.workspaceId}/join`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'workspaces'] });
    },
  });
}
