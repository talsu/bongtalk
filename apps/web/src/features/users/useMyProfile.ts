import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * task-047 iter4 (M3): Discord-parity profile page — view + edit.
 *
 * 데이터 모델은 046 iter5 (bio) + 047 iter3 (links) + customStatus 통합.
 * 단일 endpoint `/me/profile` 가 모두 cover.
 */

export interface ProfileLink {
  url: string;
  label?: string;
}

export interface MyProfile {
  id: string;
  username: string;
  email: string;
  customStatus: string | null;
  bio: string | null;
  links: ProfileLink[] | null;
}

export function useMyProfile() {
  return useQuery({
    queryKey: qk.me.profile(),
    queryFn: async (): Promise<MyProfile> => {
      return apiRequest<MyProfile>('/me/profile', { method: 'GET' });
    },
    staleTime: 30_000,
  });
}

export interface UpdateProfileInput {
  bio?: string | null;
  links?: ProfileLink[] | null;
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: UpdateProfileInput,
    ): Promise<{ bio: string | null; links: ProfileLink[] | null }> => {
      return apiRequest<{ bio: string | null; links: ProfileLink[] | null }>('/me/profile', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },
    onSuccess: (data) => {
      qc.setQueryData<MyProfile | undefined>(qk.me.profile(), (prev) => {
        if (!prev) return prev;
        return { ...prev, bio: data.bio, links: data.links };
      });
    },
  });
}
