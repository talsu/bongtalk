import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveStatus, SavedMessageDto, SavedMessageListResponse } from '@qufox/shared-types';
import { useNotifications } from '../../stores/notification-store';
import {
  getSavedCount,
  listSaved,
  saveMessage,
  savedStatusBulk,
  unsaveMessage,
  updateSavedStatus,
} from './api';

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

/**
 * S52 (FR-PS-08): 저장 항목의 탭(status) 이동. ★낙관적 — 현재(from) 탭 목록에서
 * 항목을 즉시 제거하고, 캐시된 대상(to) 탭 목록이 있으면 거기에 끼워 넣는다. 실패하면
 * onError 가 두 탭 목록을 직전 스냅샷으로 롤백하고 토스트를 띄운다. onSettled 가
 * from/to 목록 + count 를 무효화해 서버 권위로 재동기화한다.
 *
 * ★savedMessageId 는 SavedMessage.id(item.id), messageId 는 item.messageId 다 —
 * 비대칭 식별자를 둘 다 받아 from 탭 캐시 제거(id 매칭)와 무효화에 사용한다.
 */
export function useUpdateSavedStatus() {
  const qc = useQueryClient();
  const pushToast = useNotifications((s) => s.push);
  return useMutation({
    mutationFn: ({
      savedMessageId,
      to,
    }: {
      savedMessageId: string;
      from: SaveStatus;
      to: SaveStatus;
    }) => updateSavedStatus(savedMessageId, to),
    onMutate: async ({ savedMessageId, from, to }) => {
      await qc.cancelQueries({ queryKey: savedKeys.list(from) });
      await qc.cancelQueries({ queryKey: savedKeys.list(to) });
      const prevFrom = qc.getQueryData<SavedMessageListResponse>(savedKeys.list(from));
      const prevTo = qc.getQueryData<SavedMessageListResponse>(savedKeys.list(to));
      const moved = prevFrom?.items.find((it) => it.id === savedMessageId);
      // from 탭에서 즉시 제거.
      if (prevFrom) {
        qc.setQueryData<SavedMessageListResponse>(savedKeys.list(from), {
          ...prevFrom,
          items: prevFrom.items.filter((it) => it.id !== savedMessageId),
        });
      }
      // 대상 탭이 이미 캐시돼 있고 항목을 알면 맨 위에 끼워 넣는다(없으면 invalidate 가
      // 채운다 — 미캐시 탭에 임의 삽입하지 않음).
      if (prevTo && moved) {
        const next: SavedMessageDto = { ...moved, status: to };
        qc.setQueryData<SavedMessageListResponse>(savedKeys.list(to), {
          ...prevTo,
          items: [next, ...prevTo.items.filter((it) => it.id !== savedMessageId)],
        });
      }
      return { prevFrom, prevTo, from, to };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      if (ctx.prevFrom !== undefined) qc.setQueryData(savedKeys.list(ctx.from), ctx.prevFrom);
      if (ctx.prevTo !== undefined) qc.setQueryData(savedKeys.list(ctx.to), ctx.prevTo);
      pushToast({ variant: 'warning', title: '저장 항목을 이동하지 못했습니다', ttlMs: 4000 });
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: savedKeys.list(vars.from) });
      void qc.invalidateQueries({ queryKey: savedKeys.list(vars.to) });
      void qc.invalidateQueries({ queryKey: savedKeys.count() });
    },
  });
}

/**
 * S52 (FR-PS-13): 채널 진입 시 렌더 중인 메시지 id 배치에 대해 서버 저장(어느 status
 * 든) 여부를 1회 batch 로 조회해 per-message `savedKeys.status(id)` 캐시를 seed 한다
 * (N+1 단건 GET 금지). 저장된 id 는 true, 그 외(요청에 포함됐으나 미저장)는 false 로
 * 명시 seed 해 빈 북마크/채운 북마크가 서버 상태와 일치하게 만든다. 토글 캐시가 이미
 * 있으면(낙관적 갱신 직후) 덮어쓰지 않는다.
 */
export function useInitSavedStatus(messageIds: string[]): void {
  const qc = useQueryClient();
  // 안정 키 — 동일 배치 반복 호출 방지(id 정렬 join).
  const key = [...messageIds].sort().join(',');
  useEffect(() => {
    if (messageIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await savedStatusBulk(messageIds);
        if (cancelled) return;
        const savedSet = new Set(res.saved);
        for (const id of messageIds) {
          // 이미 토글 캐시가 있으면(사용자 액션 직후) 서버 seed 로 덮어쓰지 않는다.
          if (qc.getQueryData(savedKeys.status(id)) !== undefined) continue;
          qc.setQueryData<boolean>(savedKeys.status(id), savedSet.has(id));
        }
      } catch {
        // seed 실패는 무해(북마크가 빈 상태로 남을 뿐) — 토스트/throw 하지 않는다.
      }
    })();
    return () => {
      cancelled = true;
    };
    // key 로 배치 동일성을 판단해 동일 배치의 반복 호출을 막는다(messageIds 참조가 매
    // 렌더 새로 생성돼도 정렬·join 한 key 가 같으면 effect 를 재실행하지 않는다). qc 는
    // 안정 참조이며, messageIds 는 effect 본문에서 클로저로 캡처되어 key 와 동기다.
  }, [key, qc]);
}
