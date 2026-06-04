import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WorkspaceMemberProfileView,
  UpdateWorkspaceMemberProfileInput,
  WsAvatarPresignResult,
  WsAvatarFinalizeResult,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S74 (D14 / FR-PS-06): 워크스페이스별 프로필 오버라이드(닉네임/아바타/About Me) 훅.
 *
 *   GET    /workspaces/:wsId/me/profile                → 본인 ws 프로필
 *   PATCH  /workspaces/:wsId/me/profile                → 닉네임/About Me 부분 갱신
 *   POST   /workspaces/:wsId/me/profile/avatar/presign → ws아바타 presigned POST
 *   PUT    /workspaces/:wsId/me/profile/avatar         → ws아바타 확정
 *   DELETE /workspaces/:wsId/me/profile/avatar         → ws아바타 제거
 */
export function useWorkspaceProfile(workspaceId: string) {
  return useQuery({
    queryKey: qk.workspaces.myProfile(workspaceId),
    queryFn: async (): Promise<WorkspaceMemberProfileView> =>
      apiRequest<WorkspaceMemberProfileView>(`/workspaces/${workspaceId}/me/profile`),
    staleTime: 30_000,
    enabled: Boolean(workspaceId),
  });
}

export function useUpdateWorkspaceProfile(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: UpdateWorkspaceMemberProfileInput,
    ): Promise<WorkspaceMemberProfileView> =>
      apiRequest<WorkspaceMemberProfileView>(`/workspaces/${workspaceId}/me/profile`, {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: (view) => {
      qc.setQueryData<WorkspaceMemberProfileView | undefined>(
        qk.workspaces.myProfile(workspaceId),
        () => view,
      );
      // 멤버목록의 ws nickname 오버라이드 반영을 위해 무효화(낮은 빈도 fetch).
      qc.invalidateQueries({ queryKey: qk.workspaces.members(workspaceId) });
    },
  });
}

export function useWorkspaceAvatarPresign(workspaceId: string) {
  return useMutation({
    mutationFn: async (input: {
      contentType: string;
      sizeBytes: number;
    }): Promise<WsAvatarPresignResult> =>
      apiRequest<WsAvatarPresignResult>(`/workspaces/${workspaceId}/me/profile/avatar/presign`, {
        method: 'POST',
        body: input,
      }),
  });
}

export function useWorkspaceAvatarFinalize(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string): Promise<WsAvatarFinalizeResult> =>
      apiRequest<WsAvatarFinalizeResult>(`/workspaces/${workspaceId}/me/profile/avatar`, {
        method: 'PUT',
        body: { key },
      }),
    onSuccess: (res) => {
      qc.setQueryData<WorkspaceMemberProfileView | undefined>(
        qk.workspaces.myProfile(workspaceId),
        (prev) => (prev ? { ...prev, avatarUrl: res.avatarUrl } : prev),
      );
      qc.invalidateQueries({ queryKey: qk.workspaces.members(workspaceId) });
    },
  });
}

export function useWorkspaceAvatarDelete(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await apiRequest<void>(`/workspaces/${workspaceId}/me/profile/avatar`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.setQueryData<WorkspaceMemberProfileView | undefined>(
        qk.workspaces.myProfile(workspaceId),
        (prev) => (prev ? { ...prev, avatarUrl: null } : prev),
      );
      qc.invalidateQueries({ queryKey: qk.workspaces.members(workspaceId) });
    },
  });
}
