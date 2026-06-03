import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listChannelOverrides,
  upsertChannelMemberOverride,
  upsertChannelRoleOverride,
} from './api';

/**
 * S62 (FR-RM14): 채널 권한 오버라이드 read/upsert 훅. 저장 성공 시 목록 쿼리를
 * invalidate 해 서버가 캐시 DEL(≤300ms) 후 재계산한 상태를 다시 받아온다.
 */
const keys = {
  overrides: (wsId: string, channelId: string) => ['channel-overrides', wsId, channelId] as const,
};

export function useChannelPermissions(wsId: string | undefined, channelId: string | undefined) {
  return useQuery({
    queryKey: keys.overrides(wsId ?? '', channelId ?? ''),
    queryFn: () => listChannelOverrides(wsId!, channelId!),
    enabled: !!wsId && !!channelId,
  });
}

export function useUpsertChannelOverride(wsId: string, channelId: string) {
  const qc = useQueryClient();
  const invalidate = (): Promise<void> =>
    qc.invalidateQueries({ queryKey: keys.overrides(wsId, channelId) });

  const roleMut = useMutation({
    mutationFn: (input: Parameters<typeof upsertChannelRoleOverride>[2]) =>
      upsertChannelRoleOverride(wsId, channelId, input),
    onSuccess: invalidate,
  });

  const memberMut = useMutation({
    mutationFn: (input: Parameters<typeof upsertChannelMemberOverride>[2]) =>
      upsertChannelMemberOverride(wsId, channelId, input),
    onSuccess: invalidate,
  });

  return { roleMut, memberMut };
}
