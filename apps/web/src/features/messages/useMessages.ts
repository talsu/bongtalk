import { useCallback, useEffect } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import {
  deleteMessage,
  listMessages,
  pinMessage,
  sendMessage,
  unpinMessage,
  updateMessage,
} from './api';
import { qk } from '../../lib/query-keys';
import { useAuth } from '../auth/AuthProvider';
import { useNotifications } from '../../stores/notification-store';
import { friendlyError } from '../../lib/error-messages';

const keys = {
  // Route through the single qk registry so the realtime dispatcher and
  // this hook build the IDENTICAL tuple — reviewer flagged drift risk.
  // DM callers pass null for wsId; the qk helper accepts the sentinel
  // 'global' to keep tuples distinct across DM channels.
  list: (wsId: string | null, channelId: string) => qk.messages.list(wsId ?? 'global', channelId),
};

/**
 * task-041 B-2 (review M2): pure body builder for the send-failure
 * toast. Takes the bubbled API error (which may carry `.status` /
 * `.errorCode` from `bubbleError` in `lib/api.ts`) and returns the
 * Korean title + body. Branches:
 *   - undefined status → network down ("네트워크 연결을 확인하세요.")
 *   - status without errorCode → "서버 응답 NNN. ..."
 *   - status with errorCode    → "서버 응답 NNN (CODE). ..."
 *
 * Exported for testing — the mutation-driven spec asserts each branch
 * without rendering React, fixing review M2's "grep-only" coverage.
 */
export function buildSendFailureToastBody(err: unknown): { title: string; body: string } {
  const status = (err as { status?: number } | undefined)?.status;
  const code = (err as { errorCode?: string } | undefined)?.errorCode;
  return {
    title: '메시지 전송 실패',
    body:
      status === undefined
        ? '네트워크 연결을 확인하세요.'
        : `서버 응답 ${status}${code ? ` (${code})` : ''}. 잠시 후 다시 시도하세요.`,
  };
}

export function useMessageHistory(wsId: string | null, channelId: string) {
  return useInfiniteQuery({
    queryKey: keys.list(wsId, channelId),
    queryFn: ({ pageParam }) =>
      listMessages(wsId, channelId, {
        limit: 50,
        before: (pageParam as string | undefined) ?? undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListMessagesResponse) =>
      last.pageInfo.hasMore ? (last.pageInfo.nextCursor ?? undefined) : undefined,
    // DM mode passes wsId=null intentionally (routes to /me/dms/…); the
    // enabled gate must only require channelId so the history still
    // loads. The previous `!!wsId && !!channelId` left DMs stuck on
    // the empty-state placeholder.
    enabled: !!channelId,
  });
}

export function useSendMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();

  const mutation = useMutation({
    mutationFn: async (args: {
      content: string;
      tempId: string;
      idempotencyKey: string;
      attachmentIds?: string[];
    }) =>
      sendMessage(
        wsId,
        channelId,
        {
          content: args.content,
          ...(args.attachmentIds && args.attachmentIds.length > 0
            ? { attachmentIds: args.attachmentIds }
            : {}),
        },
        args.idempotencyKey,
      ),
    onMutate: async ({ content, tempId }) => {
      await qc.cancelQueries({ queryKey: keys.list(wsId, channelId) });
      const prev = qc.getQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId));
      // Optimistic prepend with a tempId — server roundtrip replaces it.
      // authorId resolves to the real viewer id so MessageList's
      // continuation rule (same author + <5min gap) matches the
      // previous row without waiting for the server echo — avoids a
      // head→cont visual flip on every send.
      const optimistic: MessageDto = {
        id: tempId,
        channelId,
        authorId: user?.id ?? 'optimistic',
        content,
        // S02: optimistic 메시지는 아직 서버 파싱 전이라 contentAst 가 없음.
        // MessageItem 이 contentAst 부재 시 contentRaw/content 정규식 렌더로
        // 폴백하므로 pending 상태에서도 본문이 보입니다. 서버 에코로 교체될
        // 때 contentAst 가 채워집니다.
        contentRaw: content,
        contentAst: null,
        mentions: { users: [], channels: [], everyone: false, here: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        reactions: [],
        parentMessageId: null,
        thread: null,
        attachments: [],
        // task-044-iter2: optimistic 메시지는 항상 미고정 상태입니다.
        pinnedAt: null,
        pinnedBy: null,
      };
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        return {
          ...old,
          pages: [{ ...first, items: [optimistic, ...first.items] }, ...rest],
        };
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.list(wsId, channelId), ctx.prev);
      // task-040 R3 + task-041 B-2 (review M2 follow): surface send
      // failure via a danger toast. Body builder extracted so the
      // mutation-driven test can assert each error-shape branch
      // without spinning up React.
      useNotifications.getState().push({
        variant: 'danger',
        ...buildSendFailureToastBody(err),
        ttlMs: 5000,
      });
    },
    onSuccess: (result, { tempId }) => {
      // Replace optimistic row (by tempId) with the server row.
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p, i) =>
            i === 0
              ? {
                  ...p,
                  items: p.items.map((m) => (m.id === tempId ? result.message : m)),
                }
              : p,
          ),
        };
      });
    },
  });

  const send = useCallback(
    (content: string, attachmentIds?: string[]) => {
      const tempId = `tmp-${crypto.randomUUID()}`;
      const idempotencyKey = crypto.randomUUID();
      mutation.mutate({ content, tempId, idempotencyKey, attachmentIds });
    },
    [mutation],
  );

  return { send, mutation };
}

export function useUpdateMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ msgId, content }: { msgId: string; content: string }) =>
      updateMessage(wsId, channelId, msgId, { content }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    // task-047 iter6 (P-individual): friendlyError → toast.
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 수정 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

export function useDeleteMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => deleteMessage(wsId, channelId, msgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    // task-047 iter6 (P-individual): friendlyError → toast.
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 삭제 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

/**
 * task-045 iter1: pin / unpin mutations. DM 채널 (wsId=null) 은
 * BE 가 pinned 미지원 — 호출자가 wsId 존재 시에만 dropdown 노출
 * 책임집니다. 성공 시 invalidate 하여 메시지 list 의 pinnedAt 갱신.
 * (WS dispatcher 의 MESSAGE_PIN_TOGGLED 가 broadcast 단에서도 별도
 * 갱신 — 두 path 가 idempotent 하게 동일한 cache 도달.)
 */
export function usePinMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 메시지 고정을 지원하지 않습니다'));
      }
      return pinMessage(wsId, channelId, msgId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 고정 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

export function useUnpinMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => {
      if (!wsId) {
        return Promise.reject(new Error('DM 채널은 메시지 고정을 지원하지 않습니다'));
      }
      return unpinMessage(wsId, channelId, msgId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    onError: (err) => {
      const f = friendlyError(err);
      useNotifications.getState().push({
        variant: 'danger',
        title: '메시지 고정 해제 실패',
        body: f.message,
        ttlMs: 5000,
      });
    },
  });
}

/** Trigger fetchNextPage when the user scrolls near the top of a message list. */
export function useScrollFetch(
  rootRef: React.RefObject<HTMLElement>,
  onReachTop: () => void,
): void {
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 100) onReachTop();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [rootRef, onReachTop]);
}
