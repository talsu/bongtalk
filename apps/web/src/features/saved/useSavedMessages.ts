import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveStatus, SavedMessageListResponse } from '@qufox/shared-types';
import { getSavedCount, listSaved, saveMessage, unsaveMessage } from './api';

// S51 (D10 / FR-PS-07): 개인 저장함 React Query 훅.
export const savedKeys = {
  // 탭별(status) 목록.
  list: (status: SaveStatus) => ['saved', 'list', status] as const,
  // 사이드바 "저장됨" IN_PROGRESS 카운트 배지.
  count: () => ['saved', 'count'] as const,
  // 특정 메시지의 저장 여부(낙관적 토글 캐시).
  status: (messageId: string) => ['saved', 'status', messageId] as const,
};

export function useSavedList(status: SaveStatus) {
  return useQuery<SavedMessageListResponse>({
    queryKey: savedKeys.list(status),
    queryFn: () => listSaved(status, { limit: 50 }),
  });
}

export function useSavedCount() {
  return useQuery({
    queryKey: savedKeys.count(),
    queryFn: () => getSavedCount(),
  });
}

/**
 * 메시지 저장/해제 토글. 낙관적으로 per-message saved 캐시를 뒤집고, 성공/실패 시
 * 목록·카운트를 무효화한다(서버가 권위). 실패하면 onError 가 직전 값으로 롤백한다.
 */
export function useToggleSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, currentlySaved }: { messageId: string; currentlySaved: boolean }) =>
      currentlySaved ? unsaveMessage(messageId) : saveMessage(messageId),
    onMutate: async ({ messageId, currentlySaved }) => {
      await qc.cancelQueries({ queryKey: savedKeys.status(messageId) });
      const prev = qc.getQueryData<boolean>(savedKeys.status(messageId));
      qc.setQueryData(savedKeys.status(messageId), !currentlySaved);
      return { prev, messageId };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx && ctx.prev !== undefined) {
        qc.setQueryData(savedKeys.status(ctx.messageId), ctx.prev);
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: savedKeys.status(vars.messageId) });
      void qc.invalidateQueries({ queryKey: ['saved', 'list'] });
      void qc.invalidateQueries({ queryKey: savedKeys.count() });
    },
  });
}

/** per-message 저장 여부 캐시 읽기(렌더 시 북마크 아이콘 상태). */
export function useIsSaved(messageId: string): boolean {
  const qc = useQueryClient();
  return qc.getQueryData<boolean>(savedKeys.status(messageId)) === true;
}
