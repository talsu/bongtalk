import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteChannelOverride,
  listChannelOverrides,
  upsertChannelMemberOverride,
  upsertChannelRoleOverride,
} from './api';
import { qk } from '../../lib/query-keys';

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
  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: keys.overrides(wsId, channelId) });
    // 072 백로그 S-F 리뷰(LOW): 채널 권한 override 변경은 메시지 리스트 응답의
    // viewerPermissions.canManageMessages 를 바꾸므로 메시지 리스트도 무효화해 suppress
    // 버튼 노출이 즉시 재정합되게 한다(override 는 저빈도라 비용 미미 · 서버가 진실 게이트라
    // 누락돼도 안전하지만 stale 버튼 UX 를 없앤다).
    await qc.invalidateQueries({ queryKey: qk.messages.list(wsId, channelId) });
  };

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

  // 072 백로그 S-J (FR-RM14): override(USER/ROLE) 해제. 성공 시 동일 invalidate 로
  // 목록 + 메시지 리스트(viewerPermissions) 재정합.
  const deleteMut = useMutation({
    mutationFn: (overrideId: string) => deleteChannelOverride(wsId, channelId, overrideId),
    onSuccess: invalidate,
  });

  return { roleMut, memberMut, deleteMut };
}
