import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export interface MentionSummary {
  messageId: string;
  channelId: string;
  workspaceId: string;
  authorId: string;
  snippet: string;
  createdAt: string;
  everyone: boolean;
  // S44 contract fix-forward: @here 멘션 표식. mention:new wire payload(서버
  // MentionReceivedPayload)와 정합한다. REST 인박스 응답도 동일 필드를 실어야
  // 일관되며, 미실릴 경우 dispatcher 캐시 병합과 형태가 어긋날 수 있다.
  here: boolean;
  // S88a review F2 (FR-MN-03): 역할 멘션(@role) 유래 표식. dispatcher 캐시 병합과
  // 형태를 맞추기 위해 optional 로 둔다(명시 @user 와 dedup 시 false · 구 응답 호환).
  role?: boolean;
  // FR-MN-10 (066 / S93): 키워드 알림(mention-scan) 유래 표식. REST 인박스 응답(서버
  // MentionSummary.keyword) 및 dispatcher mention:new 캐시 병합과 정합 · optional(구 응답 호환).
  keyword?: boolean;
}

export interface MentionInboxResponse {
  unreadCount: number;
  recent: MentionSummary[];
}

/**
 * Task-011-B: mention inbox + unread count. Dispatcher mutates the
 * cache when the `mention:new` wire event arrives over WS (S44 FR-MN-01 —
 * 서버 내부 outbox 는 mention.received, wire 만 콜론 mention:new); this hook is
 * the plain read path.
 */
export function useMentionInbox() {
  return useQuery({
    queryKey: ['me', 'mentions'] as const,
    queryFn: () => apiRequest<MentionInboxResponse>('/me/mentions'),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}
