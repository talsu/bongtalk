import { useCallback, useEffect, useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type { ListMessagesQuery, ListMessagesResponse, MessageDto } from '@qufox/shared-types';
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
import {
  confirmOptimistic,
  markOptimisticFailed,
  markOptimisticPending,
  nonceFromOptimisticId,
  optimisticIdFor,
  type OptimisticMessage,
} from './sendState';
import { applyTimeoutFailure } from './timeoutFlip';
import { messageSendTimeoutMs } from './sendTimeout';
import { lruKey, useChannelLruStore } from '../realtime/channelLru';
import { useReadState } from '../realtime/readStateStore';

const keys = {
  // Route through the single qk registry so the realtime dispatcher and
  // this hook build the IDENTICAL tuple — reviewer flagged drift risk.
  // DM callers pass null for wsId; the qk helper accepts the sentinel
  // 'global' to keep tuples distinct across DM channels.
  list: (wsId: string | null, channelId: string) => qk.messages.list(wsId ?? 'global', channelId),
};

/**
 * S05 (FR-MSG-06): 편집 낙관적 잠금 409 처리. 단일 출처 — useUpdateMessage 의
 * onError 와 editConflict.spec 이 **이 동일 함수**를 공유해 테스트 drift 를
 * 막는다(reviewer MED-2). 에러가 MESSAGE_VERSION_CONFLICT 면 서버가 details.current
 * 로 실어보낸 최신 MessageDto 로 캐시 행을 교체(낙관적 편집 롤백 + 최신 본문 반영)
 * 하고 안내 토스트를 push 한 뒤 `true` 를 반환한다. 그 외 코드면 아무것도 안 하고
 * `false` 를 반환해 호출부가 일반 에러 처리로 이어가게 한다.
 */
export function applyEditConflict(
  qc: QueryClient,
  wsId: string | null,
  channelId: string,
  err: unknown,
): boolean {
  const code = (err as { errorCode?: string } | undefined)?.errorCode;
  if (code !== 'MESSAGE_VERSION_CONFLICT') return false;
  const current = (err as { details?: { current?: MessageDto } } | undefined)?.details?.current;
  if (current) {
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((p) => ({
          ...p,
          items: p.items.map((m) => (m.id === current.id ? current : m)),
        })),
      };
    });
  }
  useNotifications.getState().push({
    variant: 'danger',
    title: '메시지 수정 실패',
    body: '다른 곳에서 수정되었습니다. 최신 내용을 확인하세요.',
    ttlMs: 5000,
  });
  return true;
}

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

/**
 * S09 (FR-RT-22): 메시지 목록 페이지의 fetch 쿼리 인자 결정 — 단일 출처.
 *
 * LRU 로 evict 됐던 채널을 재진입하는 **초기 로드**(pageParam undefined)면,
 * 보유한 lastReadMessageId 를 중심으로 `around` 재로드해 사용자가 마지막으로
 * 읽던 지점으로 복원합니다. lastRead 가 없거나 evict 이력이 없으면 around
 * 없이 최신 로드로 폴백합니다(과설계 방지). older-page fetch(pageParam 존재)는
 * 항상 `before` 커서를 씁니다.
 *
 * S30 fix-forward (BLOCKER 기능 M2): 검색 결과 점프(`?msg=<id>`)가 있으면 초기
 * 로드에서 그 메시지를 `around` anchor 로 삼습니다. lastRead 기반 복원보다
 * **우선**합니다(사용자가 명시적으로 그 메시지로 점프하길 원했으므로).
 * jumpMessageId 가 있으면 LRU around 소비 분기는 건너뜁니다.
 *
 * 부수효과(consumeAround 1회성 소비)를 포함하므로 queryFn 호출당 한 번만
 * 호출해야 합니다. 훅과 테스트가 공유합니다.
 */
export function resolveListFetchArgs(
  wsId: string | null,
  channelId: string,
  pageParam: string | undefined,
  jumpMessageId?: string | null,
): Partial<ListMessagesQuery> {
  if (pageParam === undefined) {
    // M2: 검색 점프 anchor 가 lastRead 복원보다 우선. (jump 가 있으면 LRU
    // around 플래그는 소비하지 않고 그대로 둔다 — 점프가 곧 around 로드이므로.)
    if (jumpMessageId) return { limit: 50, around: jumpMessageId };
    const wantsAround = useChannelLruStore.getState().consumeAround(lruKey(wsId, channelId));
    if (wantsAround) {
      const around = useReadState.getState().getLastRead(channelId);
      if (around) return { limit: 50, around };
    }
  }
  return { limit: 50, before: pageParam ?? undefined };
}

export function useMessageHistory(
  wsId: string | null,
  channelId: string,
  // S30 fix-forward (M2): 검색 결과 점프 anchor. 있으면 초기 로드의 around
  // 로 사용(lastRead 복원보다 우선). 호출자가 소비 후 제거하므로 1회성.
  jumpMessageId?: string | null,
) {
  return useInfiniteQuery({
    queryKey: keys.list(wsId, channelId),
    queryFn: ({ pageParam }) =>
      listMessages(
        wsId,
        channelId,
        resolveListFetchArgs(wsId, channelId, pageParam as string | undefined, jumpMessageId),
      ),
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

  // S09 (FR-RT-05): in-flight 전송별 타임아웃 타이머 + AbortController.
  // optimisticId(=`tmp-<nonce>`) 로 키잉해 onSuccess/onError(settle) 시
  // 해당 타이머를 clear 하고 controller 를 폐기합니다. 재시도는 동일
  // optimisticId 로 다시 mutate 되므로 이전 엔트리를 덮어씁니다.
  const pendingRef = useRef<
    Map<string, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>
  >(new Map());

  const clearPending = useCallback((optimisticId: string) => {
    const entry = pendingRef.current.get(optimisticId);
    if (entry) {
      clearTimeout(entry.timer);
      pendingRef.current.delete(optimisticId);
    }
  }, []);

  // 언마운트 시 남은 타이머 정리(메모리 누수/유령 flip 방지).
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const mutation = useMutation({
    // S03 (FR-MSG-04): `clientNonce` is the SINGLE identifier. The optimistic
    // row id is `optimisticIdFor(clientNonce)`, the POST body `nonce` and the
    // `Idempotency-Key` header all derive from it — no separate tempId.
    mutationFn: async (args: {
      content: string;
      clientNonce: string;
      attachmentIds?: string[];
    }) => {
      const optimisticId = optimisticIdFor(args.clientNonce);
      // S09 (FR-RT-05): 전송 시작과 동시에 타임아웃 타이머 + AbortController 를
      // 건다. 타임아웃 경과해도 201 미수신이면 hung fetch 를 abort 하고 해당
      // 낙관 행을 'failed' 로 flip 한다(applyTimeoutFailure 가 confirmed/failed
      // 이면 no-op → onError/onSuccess 와의 이중 flip 을 막음). 같은
      // optimisticId 로 in-flight 가 남아있으면(재시도) 이전 타이머를 먼저 정리.
      clearPending(optimisticId);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        // 타이머가 발화하면: 캐시 행이 여전히 pending 일 때만 failed 로 flip.
        qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) =>
          applyTimeoutFailure(old, optimisticId),
        );
        // hung fetch 를 끊는다. AbortError 가 onError 로 흐를 수 있으나
        // 행은 이미 failed 이고 applyTimeoutFailure/markOptimisticFailed 는
        // idempotent 라 이중 flip 이 발생하지 않는다. 전송 실패 토스트는
        // 1회 노출된다.
        controller.abort();
      }, messageSendTimeoutMs());
      pendingRef.current.set(optimisticId, { timer, controller });
      return sendMessage(
        wsId,
        channelId,
        {
          content: args.content,
          ...(args.attachmentIds && args.attachmentIds.length > 0
            ? { attachmentIds: args.attachmentIds }
            : {}),
        },
        // clientNonce → POST body nonce + Idempotency-Key header.
        args.clientNonce,
        controller.signal,
      );
    },
    onMutate: async ({ content, clientNonce }) => {
      await qc.cancelQueries({ queryKey: keys.list(wsId, channelId) });
      const optimisticId = optimisticIdFor(clientNonce);
      // Optimistic prepend. authorId resolves to the real viewer id so
      // MessageList's continuation rule (same author + <5min gap) matches the
      // previous row without waiting for the server echo. `sendState:'pending'`
      // drives the clock/spinner affordance; on failure we flip it to 'failed'
      // and KEEP the row (FR-MSG-05) so a "다시 시도" button can re-fire the
      // same clientNonce.
      const optimistic: OptimisticMessage = {
        id: optimisticId,
        channelId,
        authorId: user?.id ?? 'optimistic',
        content,
        // S02: optimistic 메시지는 아직 서버 파싱 전이라 contentAst 가 없음.
        // MessageItem 이 contentAst 부재 시 contentRaw/content 정규식 렌더로
        // 폴백하므로 pending 상태에서도 본문이 보입니다. 서버 에코로 교체될
        // 때 contentAst 가 채워집니다.
        contentRaw: content,
        contentAst: null,
        // S04: optimistic 메시지는 항상 일반 메시지(DEFAULT).
        type: 'DEFAULT',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
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
        // S05 (FR-MSG-06): optimistic 메시지는 아직 서버 row 가 없어 version 0.
        // 서버 에코(message:created)로 실제 version 으로 교체됩니다.
        version: 0,
        sendState: 'pending',
      };
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        if (!first) return old;
        // If this is a RETRY, the failed row already exists — flip it back to
        // pending instead of duplicating it.
        const exists = first.items.some((m) => m.id === optimisticId);
        if (exists) return markOptimisticPending(old, optimisticId) ?? old;
        return { ...old, pages: [{ ...first, items: [optimistic, ...first.items] }, ...rest] };
      });
      return { optimisticId };
    },
    onError: (err, vars, ctx) => {
      // FR-MSG-05: do NOT roll the row out — mark it failed so the bubble keeps
      // showing the content + a "다시 시도" button (same clientNonce on retry).
      const optimisticId = ctx?.optimisticId ?? optimisticIdFor(vars.clientNonce);
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) =>
        markOptimisticFailed(old, optimisticId),
      );
      // task-040 R3 + task-041 B-2 (review M2 follow): surface send failure via
      // a danger toast. Body builder extracted so the mutation-driven test can
      // assert each error-shape branch without spinning up React.
      useNotifications.getState().push({
        variant: 'danger',
        ...buildSendFailureToastBody(err),
        ttlMs: 5000,
      });
    },
    onSuccess: (result, { clientNonce }) => {
      // Replace the optimistic row with the confirmed server row. The
      // message:created WS echo may race this — confirmOptimistic is
      // idempotent (no-op if the row is already gone, FR-RT-24 dedupe).
      const optimisticId = optimisticIdFor(clientNonce);
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) =>
        confirmOptimistic(old, optimisticId, result.message),
      );
    },
    onSettled: (_result, _err, { clientNonce }) => {
      // S09 (FR-RT-05): 성공/실패 무관하게 settle 되면 타임아웃 타이머를
      // 즉시 clear 한다 — 정상 201 후 타이머가 늦게 발화해 confirmed 행을
      // 건드리는 일이 없도록(applyTimeoutFailure 가 no-op 이긴 하나 타이머
      // 누수를 막는 게 정석).
      clearPending(optimisticIdFor(clientNonce));
    },
  });

  const send = useCallback(
    (content: string, attachmentIds?: string[]) => {
      // FR-MSG-04: ONE UUID v4 — used as the optimistic id seed, POST body
      // nonce, and Idempotency-Key header.
      const clientNonce = crypto.randomUUID();
      mutation.mutate({ content, clientNonce, attachmentIds });
    },
    [mutation],
  );

  /**
   * FR-MSG-05: retry a failed send. The caller passes the optimistic row's id
   * (which encodes the original clientNonce); the retry re-fires with the SAME
   * nonce so the server dedupes against the original Idempotency-Key.
   */
  const retry = useCallback(
    (failedId: string, content: string, attachmentIds?: string[]) => {
      // S03 review NIT: recover the original clientNonce from the optimistic
      // row id (`tmp-<nonce>`). A failed row id is ALWAYS optimistic, so a
      // null here means the caller passed a confirmed/server id by mistake —
      // feeding that raw into `nonce: z.string().uuid()` would 400 with a
      // generic toast. Bail loudly in dev instead of silently misfiring.
      const clientNonce = nonceFromOptimisticId(failedId);
      if (clientNonce === null) {
        if (import.meta.env.DEV) {
          throw new Error(`retry() expected an optimistic id, got "${failedId}"`);
        }
        return;
      }
      mutation.mutate({ content, clientNonce, attachmentIds });
    },
    [mutation],
  );

  return { send, retry, mutation };
}

/**
 * S05 (FR-MSG-06): 메시지 편집 mutation. 편집창 오픈 시 스냅샷한
 * `expectedVersion` 을 PATCH 에 항상 동봉합니다(낙관적 잠금).
 *
 * 409(MESSAGE_VERSION_CONFLICT) 수신 시: 서버가 details.current 로 실어보낸
 * 최신 MessageDto 로 캐시 행을 즉시 교체(낙관적 편집 롤백 + 최신 본문 반영)
 * 하고 "다른 곳에서 수정되었습니다" 안내 토스트를 띄웁니다. MessageItem 의
 * onEditSave 가 reject 를 받으므로 편집창은 닫히지 않고 유지됩니다.
 */
export function useUpdateMessage(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      msgId,
      content,
      expectedVersion,
    }: {
      msgId: string;
      content: string;
      expectedVersion: number;
    }) => updateMessage(wsId, channelId, msgId, { content, expectedVersion }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
    onError: (err) => {
      // S05 (FR-MSG-06): 낙관적 잠금 충돌이면 공유 함수가 캐시 롤백 + 토스트를
      // 처리하고 true 를 반환한다 — 그 외 에러만 아래 일반 처리로 내려간다.
      if (applyEditConflict(qc, wsId, channelId, err)) return;
      // task-047 iter6 (P-individual): friendlyError → toast.
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
