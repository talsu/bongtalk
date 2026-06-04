import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProfileView,
  ProfileLink,
  UpdateProfileInput,
  AvatarPresignResult,
  AvatarFinalizeResult,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S73 (D14 / FR-PS-01·02·03): 전역 프로필 read/edit + 아바타.
 *
 * task-047 M3 의 bio/links 만 다루던 훅을 D14 전역 신원(handle/displayName/fullName/
 * pronouns/title/timezone) + 아바타로 확장한다. 응답/요청 타입은 shared-types 컨트랙트
 * (ProfileView / UpdateProfileInput / Avatar*)를 그대로 쓴다.
 */

export type { ProfileLink };
export type MyProfile = ProfileView;

export function useMyProfile() {
  return useQuery({
    queryKey: qk.me.profile(),
    queryFn: async (): Promise<ProfileView> => apiRequest<ProfileView>('/me/profile'),
    staleTime: 30_000,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProfileInput): Promise<ProfileView> =>
      apiRequest<ProfileView>('/me/profile', { method: 'PATCH', body: input }),
    onSuccess: (view) => {
      qc.setQueryData<ProfileView | undefined>(qk.me.profile(), () => view);
    },
  });
}

/** FR-PS-01: 아바타 presign → 직접 PUT → finalize. */
export function useAvatarPresign() {
  return useMutation({
    mutationFn: async (input: {
      contentType: string;
      sizeBytes: number;
    }): Promise<AvatarPresignResult> =>
      apiRequest<AvatarPresignResult>('/me/avatar/presign', {
        method: 'POST',
        body: input,
      }),
  });
}

export function useAvatarFinalize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string): Promise<AvatarFinalizeResult> =>
      apiRequest<AvatarFinalizeResult>('/me/avatar', {
        method: 'PUT',
        body: { key },
      }),
    onSuccess: (res) => {
      qc.setQueryData<ProfileView | undefined>(qk.me.profile(), (prev) =>
        prev ? { ...prev, avatarUrl: res.avatarUrl } : prev,
      );
    },
  });
}

export function useAvatarDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await apiRequest<void>('/me/avatar', { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.setQueryData<ProfileView | undefined>(qk.me.profile(), (prev) =>
        prev ? { ...prev, avatarUrl: null } : prev,
      );
    },
  });
}
