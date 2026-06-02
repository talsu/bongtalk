import { useInfiniteQuery } from '@tanstack/react-query';
import type { ListReactionUsersResponse } from '@qufox/shared-types';
import { fetchReactionUsers } from './api';
import { qk } from '../../lib/query-keys';

/**
 * S40 (FR-RE05): 한 이모지에 반응한 전체 reactor 목록을 cursor 페이지네이션으로
 * 가져오는 훅. reactor 모달이 열려 있을 때만(enabled) fetch 한다. 페이지마다 서버가
 * 돌려준 opaque nextCursor 를 그대로 다음 pageParam 으로 넘기며, null 이면 더 없음.
 * 캐시는 `['reactions','users', msgId, emoji]` 로 키잉해 메시지 목록 캐시와 분리한다.
 */
export function useReactionUsers(messageId: string | null, emoji: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.reactions.users(messageId ?? '', emoji ?? ''),
    queryFn: ({ pageParam }) =>
      fetchReactionUsers(messageId!, emoji!, {
        cursor: (pageParam as string | undefined) ?? undefined,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListReactionUsersResponse) => last.nextCursor ?? undefined,
    enabled: enabled && !!messageId && !!emoji,
    // 모달을 닫으면 즉시 파기해 stale reactor 목록이 다음 오픈에 깜빡이지 않게 한다.
    gcTime: 0,
  });
}
