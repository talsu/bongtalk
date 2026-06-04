import { useQuery } from '@tanstack/react-query';
import type { MemberFullProfileView } from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';
import { fetchMemberFullProfile } from './api';

/**
 * S75 (D14 / FR-PS-07·08): 타 멤버 전체 프로필 조회 훅. 팝오버/패널이 공유 캐시
 * (qk.workspaces.memberFullProfile)를 읽어 같은 사용자를 두 번 fetch 하지 않는다.
 * `enabled` 로 팝오버가 열렸을 때만(또는 wsId/userId 가 유효할 때만) 호출한다.
 */
export function useFullProfile(
  workspaceId: string | null | undefined,
  userId: string | null | undefined,
  enabled = true,
) {
  return useQuery<MemberFullProfileView>({
    queryKey: qk.workspaces.memberFullProfile(workspaceId ?? '', userId ?? ''),
    queryFn: () => fetchMemberFullProfile(workspaceId as string, userId as string),
    enabled: enabled && !!workspaceId && !!userId,
    staleTime: 30_000,
  });
}
