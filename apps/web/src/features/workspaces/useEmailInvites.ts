import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailInviteRole, PendingInviteAction } from '@qufox/shared-types';
import { cancelPendingInvite, inviteByEmail, listPendingInvites, updatePendingInvite } from './api';

/**
 * S68 (D13 / FR-W04·W18): 이메일 직접 초대 + 보류 초대 관리 hooks.
 * 보류 초대 목록 캐시는 invite-by-email / 연장 / 재발송 / 취소 후 무효화한다.
 */
const keys = {
  pending: (id: string) => ['workspaces', id, 'pending-invites'] as const,
};

export function usePendingInvites(id: string | undefined) {
  return useQuery({
    queryKey: keys.pending(id ?? ''),
    queryFn: () => listPendingInvites(id!),
    enabled: !!id,
  });
}

export function useInviteByEmail(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emails, role }: { emails: string[]; role: EmailInviteRole }) =>
      inviteByEmail(id, emails, role),
    onSuccess: () => {
      // 미가입 PENDING 행이 생겼을 수 있으므로 보류 목록을 갱신한다.
      qc.invalidateQueries({ queryKey: keys.pending(id) });
    },
  });
}

export function useUpdatePendingInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pendingId, action }: { pendingId: string; action: PendingInviteAction }) =>
      updatePendingInvite(id, pendingId, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.pending(id) });
    },
  });
}

export function useCancelPendingInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pendingId: string) => cancelPendingInvite(id, pendingId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.pending(id) });
    },
  });
}
