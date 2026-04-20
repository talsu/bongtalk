import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveChannel,
  createCategory,
  createChannel,
  deleteChannel,
  listChannels,
  moveCategory,
  moveChannel,
  unarchiveChannel,
  updateChannel,
} from './api';

const keys = {
  list: (wsId: string) => ['channels', wsId] as const,
};

export function useChannelList(wsId: string | undefined) {
  return useQuery({
    queryKey: keys.list(wsId ?? ''),
    queryFn: () => listChannels(wsId!),
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
