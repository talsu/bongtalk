import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * Task-010-B frontend: unread count per channel in the current
 * workspace. Hook reads the list from the server once (dispatcher
 * mutates the cache for each incoming message) and offers a
 * `mark-read` mutation.
 */

export interface UnreadChannelSummary {
  channelId: string;
  unreadCount: number;
  hasMention: boolean;
  // S21 (FR-RS-16): 읽지 않음 멘션 수. 사이드바 2계층 표시의 mention 배지 데이터.
  mentionCount: number;
  lastMessageAt: string | null;
}

interface UnreadSummaryResponse {
  channels: UnreadChannelSummary[];
}

/**
 * S22 review #5: 채널 읽음 처리 시 unread 요약 캐시에서 해당 채널을
 * "전부 0" 상태로 누른다. 낙관 패치(MessageColumn 채널 open)와
 * useMarkChannelRead.onSuccess 가 동일 모양을 공유하도록 단일 헬퍼로 둔다
 * — `unreadCount`/`mentionCount`/`hasMention` 셋 모두 zero-out 해야 사이드바
 * 멘션 배지 깜빡임이 사라진다. 캐시가 없으면 그대로 반환.
 */
export function zeroOutChannelUnread(
  old: UnreadSummaryResponse | undefined,
  channelId: string,
): UnreadSummaryResponse | undefined {
  if (!old) return old;
  return {
    channels: old.channels.map((c) =>
      c.channelId === channelId ? { ...c, unreadCount: 0, mentionCount: 0, hasMention: false } : c,
    ),
  };
}

export function useUnreadSummary(workspaceId: string | undefined) {
  return useQuery({
    queryKey: workspaceId ? qk.channels.unreadSummary(workspaceId) : ['unread-summary', 'idle'],
    queryFn: () => apiRequest<UnreadSummaryResponse>(`/workspaces/${workspaceId}/unread-summary`),
    enabled: !!workspaceId,
    // Cheap refetch on focus — the dispatcher already keeps it live, but
    // a long tab-switched session could otherwise drift.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

// 072 백로그 S-I (FR-RS-10 / N6-1): Unreads 미리보기. 읽지 않은 채널 + 채널별 최근 읽지 않은 메시지
// ≤5(작성자+본문, 차단 마스킹). 서버 GET /workspaces/:id/unreads.
export interface UnreadPreviewMessage {
  id: string;
  authorId: string | null;
  authorUsername: string | null;
  preview: string | null;
  masked: boolean;
  createdAt: string;
}
export interface UnreadChannelPreview {
  channelId: string;
  unreadCount: number;
  mentionCount: number;
  lastMessageAt: string | null;
  messages: UnreadPreviewMessage[];
}
export interface UnreadsPreviewPage {
  items: UnreadChannelPreview[];
  nextCursor: string | null;
}

/**
 * 072 백로그 S-I: Unreads 미리보기 1페이지(첫 ~20채널·채널별 ≤5 메시지). UnreadsView 가
 * 채널명·배지(useUnreadSummary)에 더해 최근 읽지 않음 본문 미리보기를 보여주는 데 쓴다. 미리보기는
 * 보강 정보이므로 첫 페이지만 로드한다(커서는 향후 더보기용 — 응답에 nextCursor 포함).
 */
export function useUnreadsPreview(workspaceId: string | undefined) {
  return useQuery({
    queryKey: workspaceId ? ['unreads-preview', workspaceId] : ['unreads-preview', 'idle'],
    // 072 S-I 리뷰(LOW): 서버 preview 정렬을 UnreadsView(sortUnreadsView, 멘션 우선)와
    // 일치시켰고 limit=50(MAX) 으로 요청해 표시 페이지(PAGE_SIZE 20 + load-more 누적)의
    // 미리보기 커버리지를 넓힌다. 50채널 초과는 보강 정보 특성상 라인만 비운다(graceful).
    queryFn: () => apiRequest<UnreadsPreviewPage>(`/workspaces/${workspaceId}/unreads?limit=50`),
    enabled: !!workspaceId,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

/**
 * S22 (FR-RS-02): cursor-based ACK. POST /workspaces/:id/channels/:chid/ack
 * with `{ lastReadMessageId, clientTimestamp }`. 서버는 monotonic upsert +
 * unreadCount 재계산 후 read_state:updated 를 emit 하므로(dispatcher 가 소비),
 * 여기서는 낙관적 캐시 패치 없이 전송만 한다(서버 권위 + WS 동기화).
 *
 * 5초 디바운스 / scroll-to-bottom 즉시 발화 정책은 AckScheduler(ackScheduler.ts)
 * 가 담당하고, 이 훅은 그 onFlush 가 호출하는 전송 단위다.
 */
export function useAckChannelRead(workspaceId: string | undefined) {
  return useMutation({
    mutationFn: async (input: {
      channelId: string;
      lastReadMessageId: string;
      /** epoch millis — AckReadRequestSchema 가 number 를 받는다. */
      clientTimestamp: number;
    }) => {
      if (!workspaceId) return;
      await apiRequest(`/workspaces/${workspaceId}/channels/${input.channelId}/ack`, {
        method: 'POST',
        body: {
          lastReadMessageId: input.lastReadMessageId,
          clientTimestamp: input.clientTimestamp,
        },
      });
    },
  });
}

/**
 * S24 fix-forward (reviewer MAJOR #3 · FR-RS-09): 채널 컨텍스트 메뉴 "읽음으로
 * 표시"(ChannelList) + Unreads "읽음 처리"(UnreadsView) 의 전송 단위. 종전
 * `POST .../read`(markRead) 는 read_state:updated 를 emit 하지 않아 멀티세션이
 * desync 됐다. **emit 하는** `POST .../read-ack` 로 전환해, 서버가 채널을 최신까지
 * 읽음 처리한 뒤 read_state:updated 를 user 룸으로 fan-out 한다(dispatcher 가 다른
 * 탭/기기의 사이드바 배지를 권위 갱신). 본 탭은 즉각적 UX 를 위해 낙관 zero-out 유지.
 */
export function useMarkChannelRead(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      if (!workspaceId) return;
      await apiRequest(`/workspaces/${workspaceId}/channels/${channelId}/read-ack`, {
        method: 'POST',
      });
      return channelId;
    },
    onSuccess: (channelId) => {
      if (!workspaceId || !channelId) return;
      qc.setQueryData<UnreadSummaryResponse>(qk.channels.unreadSummary(workspaceId), (old) =>
        zeroOutChannelUnread(old, channelId),
      );
    },
  });
}

/**
 * S24 (FR-RS-08): 수동 읽지 않음 표시. POST /workspaces/:id/channels/:chid/unread
 * {messageId} 가 지정 메시지 **직전**으로 lastReadMessageId 를 되돌린다(後進 —
 * monotonic guard 우회). 서버가 read_state:updated 를 emit 하므로 dispatcher 가
 * 사이드바 배지를 권위 갱신하고, 여기서는 즉각적 UX 를 위해 낙관적으로 unread-
 * summary 캐시의 해당 채널을 응답값(unreadCount/mentionCount)으로 패치한다.
 */
export function useMarkUnread(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { channelId: string; messageId: string }) => {
      if (!workspaceId) return undefined;
      return apiRequest<{ channelId: string; unreadCount: number; mentionCount: number }>(
        `/workspaces/${workspaceId}/channels/${input.channelId}/unread`,
        { method: 'POST', body: { messageId: input.messageId } },
      );
    },
    onSuccess: (res) => {
      if (!workspaceId || !res) return;
      qc.setQueryData<UnreadSummaryResponse>(qk.channels.unreadSummary(workspaceId), (old) => {
        if (!old) return old;
        return {
          channels: old.channels.map((c) =>
            c.channelId === res.channelId
              ? {
                  ...c,
                  unreadCount: res.unreadCount,
                  mentionCount: res.mentionCount,
                  hasMention: res.mentionCount > 0,
                }
              : c,
          ),
        };
      });
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
    },
  });
}

/**
 * S24 (FR-RS-18): mark-all-read Undo. POST /workspaces/:id/read-all/undo
 * {snapshotId} 가 직전 ChannelReadState 를 복원한다(後進 허용). 복원 후 서버
 * read_state:updated fan-out 이 권위지만, 즉각적 UX 를 위해 summary/totals 를
 * 무효화해 재조회한다(낙관 패치는 채널별 카운트를 모르므로 invalidate 가 안전).
 */
export function useUndoMarkAllRead(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotId: string) => {
      if (!workspaceId) return;
      await apiRequest(`/workspaces/${workspaceId}/read-all/undo`, {
        method: 'POST',
        body: { snapshotId },
      });
    },
    onSuccess: () => {
      if (!workspaceId) return;
      qc.invalidateQueries({ queryKey: qk.channels.unreadSummary(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
    },
  });
}

/**
 * S23 (FR-RS-11): 워크스페이스 전체 읽음(Shift+Esc). POST /workspaces/:id/read-all
 * 가 가시 채널 중 읽지 않음 남은 것을 각각 최신까지 monotonic 읽음 처리한다(後進 없음).
 * 낙관적으로 unread-summary 캐시의 모든 채널을 zero-out 해 사이드바 배지가 즉시
 * 사라지게 하고, 서버 권위 + read_state:updated WS 동기화로 정합한다.
 */
export function useMarkAllRead(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId) return undefined;
      // S24 (FR-RS-18): 응답의 snapshotId 를 caller(Unreads View)가 받아 5초
      // Undo 토스트의 "실행 취소" 버튼에 싣는다.
      return apiRequest<{ channelsRead: number; snapshotId: string }>(
        `/workspaces/${workspaceId}/read-all`,
        { method: 'POST' },
      );
    },
    // S23 MAJOR fix (#4): 낙관 패치를 onMutate 로 옮기고 직전 스냅샷을 보관해
    // onError 시 롤백한다(set-based 호출 부분 실패/네트워크 오류 시 사이드바
    // 배지가 잘못 0 으로 남는 회귀 방지). 성공 시 totals 만 무효화(서버 권위).
    onMutate: async () => {
      if (!workspaceId) return { prev: undefined };
      await qc.cancelQueries({ queryKey: qk.channels.unreadSummary(workspaceId) });
      const prev = qc.getQueryData<UnreadSummaryResponse>(qk.channels.unreadSummary(workspaceId));
      qc.setQueryData<UnreadSummaryResponse>(qk.channels.unreadSummary(workspaceId), (old) =>
        zeroOutAllChannels(old),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (!workspaceId) return;
      // 낙관 zero-out 롤백 + 서버 권위로 재정렬.
      qc.setQueryData<UnreadSummaryResponse>(qk.channels.unreadSummary(workspaceId), ctx?.prev);
      qc.invalidateQueries({ queryKey: qk.channels.unreadSummary(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
    },
    onSuccess: () => {
      if (!workspaceId) return;
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
    },
  });
}

/**
 * S23 (FR-RS-11): 워크스페이스 전체 읽음 낙관 패치 — 요약 캐시의 모든 채널을
 * "전부 0" 으로 누른다. zeroOutChannelUnread(단일)와 동일한 행 모양을 공유한다.
 */
export function zeroOutAllChannels(
  old: UnreadSummaryResponse | undefined,
): UnreadSummaryResponse | undefined {
  if (!old) return old;
  return {
    channels: old.channels.map((c) => ({
      ...c,
      unreadCount: 0,
      mentionCount: 0,
      hasMention: false,
    })),
  };
}
