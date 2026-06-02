import {
  useMutation,
  useQuery,
  useQueryClient,
  useInfiniteQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import type {
  ListMyThreadsResponse,
  ListThreadRepliesResponse,
  MessageDto,
  ThreadNotificationLevel,
} from '@qufox/shared-types';
import {
  listThreadReplies,
  ackThread,
  listMyThreads,
  markAllThreadsRead,
  setThreadLock,
  setThreadNotificationLevel,
} from './api';
import { sendMessage } from '../messages/api';
import { qk } from '../../lib/query-keys';
import { useAuth } from '../auth/AuthProvider';

/**
 * Task-014-B: side-panel thread reader. Cursor-paginates via
 * nextCursor; the first page also carries the root message so the
 * panel header renders without a second request. Cache is keyed by
 * `['messages','thread', rootId]` so the realtime dispatcher can
 * append to the active thread without knowing the cursor.
 */
export function useThreadReplies(rootId: string | null) {
  return useInfiniteQuery({
    queryKey: qk.messages.thread(rootId ?? ''),
    queryFn: ({ pageParam }) =>
      listThreadReplies(rootId!, {
        cursor: (pageParam as string | undefined) ?? undefined,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListThreadRepliesResponse) =>
      last.pageInfo.hasMore ? (last.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: !!rootId,
  });
}

/**
 * S36 (FR-RS-12 / FR-TH-12): 스레드 읽음 ACK 뮤테이션. ThreadPanel 이 mount /
 * 최하단 스크롤 시(디바운스) 호출한다. onSuccess 시 채널 메시지 목록 캐시의
 * 해당 루트 threadMeta.hasUnread 를 낙관적으로 false 로 내려, reply bar 의
 * unread dot 을 ACK 즉시 끈다(다음 목록 refetch 가 서버 기준으로 재수렴).
 */
export function useAckThread(workspaceId: string, channelId: string, rootId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lastReadMessageId: string) => ackThread(rootId, lastReadMessageId),
    onSuccess: () => {
      qc.setQueryData(qk.messages.list(workspaceId, channelId), (old: unknown) => {
        const data = old as
          | { pages: { items: { id: string; thread: { hasUnread?: boolean } | null }[] }[] }
          | undefined;
        if (!data) return old;
        return {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            items: p.items.map((m) =>
              m.id === rootId && m.thread ? { ...m, thread: { ...m.thread, hasUnread: false } } : m,
            ),
          })),
        };
      });
    },
  });
}

/**
 * S38 (FR-TH-08): 스레드 알림 레벨 설정(+ 수동 구독) 뮤테이션. ThreadPanel 헤더
 * 벨 드롭다운이 호출한다. 성공 시 Threads 탭 목록 캐시를 무효화해 거기 표시되는
 * notificationLevel 도 재수렴시킨다.
 */
export function useSetThreadNotificationLevel(rootId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (level: ThreadNotificationLevel) => setThreadNotificationLevel(rootId, level),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.me.threads() });
    },
  });
}

/**
 * S38 (FR-TH-09): 내 구독 스레드 목록(Threads 탭). 미읽 우선, latestReplyAt DESC.
 */
export function useMyThreads(enabled = true) {
  return useQuery<ListMyThreadsResponse>({
    queryKey: qk.me.threads(),
    queryFn: () => listMyThreads(),
    enabled,
  });
}

/**
 * S38 (FR-TH-10): 내 구독 스레드 전체 읽음 처리. 성공 시 목록 캐시를 무효화해
 * 미읽 badge 를 0 으로 재수렴시킨다.
 */
export function useMarkAllThreadsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => markAllThreadsRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.me.threads() });
    },
  });
}

/**
 * S38 (FR-TH-13): 스레드 잠금/해제 뮤테이션(OWNER/ADMIN). 성공 시 서버가
 * thread:lock:changed 를 채널 룸으로 emit 하므로, 본인 탭의 즉시 반영은 dispatcher
 * 수신에 의존한다(낙관적 갱신은 생략 — 단일 출처 유지).
 */
export function useSetThreadLock(rootId: string) {
  return useMutation({
    mutationFn: (locked: boolean) => setThreadLock(rootId, locked),
  });
}

/**
 * Task-014-B: reply send. Reuses the regular send endpoint with the
 * parentMessageId hint. Optimistic insert lands on the thread cache
 * directly; the WS echo collapses the tempId via the dispatcher's
 * message.created branch (same as the main channel list).
 */
export function useSendReply(wsId: string, channelId: string, rootId: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const threadKey = qk.messages.thread(rootId);

  return useMutation({
    mutationFn: async (args: {
      content: string;
      tempId: string;
      idempotencyKey: string;
      // S35 (FR-TH-06): 'Also send to #channel' 체크 상태. true 면 서버가
      // SYSTEM_THREAD_BROADCAST 채널 행을 동시 게시한다(채널 타임라인 broadcast
      // 는 별도 WS 이벤트로 도착하므로 여기 thread 캐시 낙관적 삽입과 무관).
      isBroadcast?: boolean;
    }) =>
      sendMessage(
        wsId,
        channelId,
        {
          content: args.content,
          parentMessageId: rootId,
          isBroadcast: args.isBroadcast === true ? true : undefined,
        },
        args.idempotencyKey,
      ),
    onMutate: async ({ content, tempId }) => {
      await qc.cancelQueries({ queryKey: threadKey });
      const prev = qc.getQueryData<InfiniteData<ListThreadRepliesResponse>>(threadKey);
      // Resolve the viewer id up-front so MessageList/ThreadPanel's
      // same-author continuation rule matches without the server echo.
      const optimistic: MessageDto = {
        id: tempId,
        channelId,
        authorId: user?.id ?? 'optimistic',
        content,
        // S02: optimistic reply 도 서버 파싱 전 — contentAst 없으면
        // MessageItem 이 contentRaw 폴백 렌더. 서버 에코로 채워짐.
        contentRaw: content,
        contentAst: null,
        // S37 (FR-MSG-17): optimistic reply 평문 정본도 원문 그대로(서버 에코로 갱신).
        contentPlain: content,
        // S04: optimistic reply 는 항상 일반 메시지(DEFAULT).
        type: 'DEFAULT',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        reactions: [],
        parentMessageId: rootId,
        thread: null,
        attachments: [],
        pinnedAt: null,
        pinnedBy: null,
        // S05 (FR-MSG-06): optimistic reply 는 서버 row 전이라 version 0.
        version: 0,
        // S35 (FR-TH-06): 답글 자체는 broadcast 행이 아니다(broadcast 는 채널
        // 타임라인의 별도 SYSTEM 행으로 도착). thread 캐시에 들어가는 이 낙관적
        // 행은 항상 일반 답글.
        isBroadcast: false,
        parentExcerpt: null,
        // S38 (FR-TH-13): 답글은 잠금 표식 없음(루트 전용).
        threadLocked: false,
      };
      qc.setQueryData<InfiniteData<ListThreadRepliesResponse>>(threadKey, (old) => {
        if (!old) return old;
        const last = old.pages[old.pages.length - 1];
        return {
          ...old,
          pages: [...old.pages.slice(0, -1), { ...last, replies: [...last.replies, optimistic] }],
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(threadKey, ctx.prev);
    },
    onSuccess: (result, { tempId }) => {
      qc.setQueryData<InfiniteData<ListThreadRepliesResponse>>(threadKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            replies: p.replies.map((r) => (r.id === tempId ? result.message : r)),
          })),
        };
      });
    },
  });
}
