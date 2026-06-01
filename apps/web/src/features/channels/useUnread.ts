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
  // S21 (FR-RS-16): 미읽음 멘션 수. 사이드바 2계층 표시의 mention 배지 데이터.
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

export function useMarkChannelRead(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      if (!workspaceId) return;
      await apiRequest(`/workspaces/${workspaceId}/channels/${channelId}/read`, {
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
