import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  getWorkspace,
  leaveWorkspace,
  listInvites,
  listMembers,
  listMyWorkspaces,
  previewInvite,
  updateMemberRole,
  updateWorkspace,
} from './api';

const keys = {
  mine: ['workspaces', 'mine'] as const,
  one: (id: string) => ['workspace', id] as const,
  members: (id: string) => ['workspace', id, 'members'] as const,
  invites: (id: string) => ['workspace', id, 'invites'] as const,
  invitePreview: (code: string) => ['invite', code, 'preview'] as const,
};

export function useMyWorkspaces() {
  return useQuery({ queryKey: keys.mine, queryFn: listMyWorkspaces });
}

export function useWorkspace(id: string | undefined) {
  return useQuery({
    queryKey: keys.one(id ?? ''),
    queryFn: () => getWorkspace(id!),
    enabled: !!id,
  });
}

export function useMembers(id: string | undefined) {
  return useQuery({
    queryKey: keys.members(id ?? ''),
    queryFn: () => listMembers(id!),
    enabled: !!id,
  });
}

export function useInvites(id: string | undefined) {
  return useQuery({
    queryKey: keys.invites(id ?? ''),
    queryFn: () => listInvites(id!),
    enabled: !!id,
  });
}

export function useInvitePreview(code: string | undefined) {
  return useQuery({
    queryKey: keys.invitePreview(code ?? ''),
    queryFn: () => previewInvite(code!),
    enabled: !!code,
    retry: false,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

export function useUpdateWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof updateWorkspace>[1]) => updateWorkspace(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.one(id) });
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

export function useUpdateRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'ADMIN' | 'MEMBER' }) =>
      updateMemberRole(id, userId, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

export function useCreateInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createInvite>[1]) => createInvite(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.invites(id) });
    },
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: acceptInvite,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

export function useLeaveWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => leaveWorkspace(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}
