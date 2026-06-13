import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveChannel,
  createCategory,
  createChannel,
  deleteChannel,
  joinChannel,
  leaveChannel,
  listChannels,
  listBrowsableChannels,
  moveCategory,
  moveChannel,
  unarchiveChannel,
  updateChannel,
} from './api';

const keys = {
  list: (wsId: string) => ['channels', wsId] as const,
  // 072 백로그 S-D (FR-CH-06): 채널 둘러보기(공개 채널 + memberCount/isMember) 캐시 키.
  browse: (wsId: string) => ['channels', wsId, 'browse'] as const,
};

export function useChannelList(wsId: string | undefined) {
  return useQuery({
    queryKey: keys.list(wsId ?? ''),
    queryFn: () => listChannels(wsId!),
    enabled: !!wsId,
  });
}

// 072 백로그 S-D (FR-CH-06): 채널 둘러보기 데이터. 가입/탈퇴 시 무효화돼 멤버 수 +
// 가입 여부("열기"/"가입" 분기)가 갱신된다.
export function useBrowsableChannels(wsId: string | undefined) {
  return useQuery({
    queryKey: keys.browse(wsId ?? ''),
    queryFn: () => listBrowsableChannels(wsId!),
    enabled: !!wsId,
  });
}

export function useCreateChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createChannel>[1]) => createChannel(wsId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

export function useUpdateChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateChannel>[2] }) =>
      updateChannel(wsId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

export function useDeleteChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChannel(wsId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

export function useArchiveChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveChannel(wsId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

export function useUnarchiveChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unarchiveChannel(wsId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

// S14 (FR-CH-07): 채널 가입/탈퇴. 성공 시 채널 목록을 무효화해 사이드바
// 가시성/멤버십을 갱신한다.
export function useJoinChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => joinChannel(wsId, channelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.list(wsId) });
      // 072 백로그 S-D: 둘러보기의 memberCount/isMember 도 갱신("가입"→"열기").
      qc.invalidateQueries({ queryKey: keys.browse(wsId) });
    },
  });
}

export function useLeaveChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => leaveChannel(wsId, channelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.list(wsId) });
      qc.invalidateQueries({ queryKey: keys.browse(wsId) });
    },
  });
}

export function useMoveChannel(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof moveChannel>[2] }) =>
      moveChannel(wsId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

export function useCreateCategory(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createCategory>[1]) => createCategory(wsId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}

export function useMoveCategory(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof moveCategory>[2] }) =>
      moveCategory(wsId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId) }),
  });
}
