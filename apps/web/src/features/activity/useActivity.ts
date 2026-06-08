import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export type ActivityKind = 'mention' | 'reply' | 'reaction' | 'direct' | 'friend_request';
export type ActivityFilter =
  | 'all'
  | 'mentions'
  | 'replies'
  | 'reactions'
  | 'directs'
  | 'friend_requests';

const ALL_FILTERS = [
  'all',
  'mentions',
  'replies',
  'reactions',
  'directs',
  'friend_requests',
] as const satisfies ReadonlyArray<ActivityFilter>;

export interface ActivityRow {
  activityKey: string;
  kind: ActivityKind;
  workspaceId: string;
  channelId: string;
  messageId: string;
  actorId: string;
  /** S47 fix-forward (a11y A-2): API read-time User.username join. 표시명/접근명용. */
  actorName: string | null;
  snippet: string;
  createdAt: string;
  readAt: string | null;
  // FR-MN-10 (066 / S93): 키워드 알림 유래 표식(kind='mention' 행에 한해 의미). 서버
  // ActivityRow.keyword 와 정합 · optional(구 응답 호환 — undefined→키워드 아님).
  keyword?: boolean;
}

export interface ActivityPage {
  items: ActivityRow[];
  nextCursor: string | null;
}

export interface UnreadCounts {
  total: number;
  mentions: number;
  replies: number;
  reactions: number;
  directs: number;
  friendRequests: number;
}

export function useActivityList(filter: ActivityFilter) {
  return useQuery<ActivityPage>({
    queryKey: ['me', 'activity', filter],
    queryFn: () =>
      apiRequest<ActivityPage>(`/me/activity?filter=${encodeURIComponent(filter)}&limit=50`),
    staleTime: 30_000,
  });
}

/**
 * S47 (FR-MN-13): Activity Inbox 패널용 cursor 무한스크롤. 기존 /me/activity 의
 * opaque `<iso>|<activityKey>` cursor 를 그대로 다음 pageParam 으로 넘긴다. 패널
 * 키(`['me','activity','inbox', filter]`)는 전체화면 ActivityPage 의 `['me','activity', filter]`
 * 와 분리해 캐시가 섞이지 않게 한다(둘 다 ['me','activity'] prefix 무효화는 공유).
 */
export function useActivityInbox(filter: ActivityFilter) {
  return useInfiniteQuery<ActivityPage>({
    queryKey: ['me', 'activity', 'inbox', filter],
    queryFn: ({ pageParam }) => {
      const cursor = (pageParam as string | null) ?? null;
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      return apiRequest<ActivityPage>(
        `/me/activity?filter=${encodeURIComponent(filter)}&limit=50${cursorParam}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useActivityUnread() {
  return useQuery<UnreadCounts>({
    queryKey: ['me', 'activity', 'unread-counts'],
    queryFn: () => apiRequest<UnreadCounts>('/me/activity/unread-counts'),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * S47 fix-forward (MAJOR-3): 항목 읽음 낙관 갱신. 전체화면 ActivityPage 캐시
 * (`['me','activity', filter]`)뿐 아니라 **Inbox 패널 infinite 캐시**
 * (`['me','activity','inbox', filter]`)의 페이지들도 즉시 patch 해, 패널에서
 * 클릭하면 readAt 이 바로 반영된다(종전엔 inbox 캐시 미반영 → invalidate refetch
 * 전까지 unread 표시 잔류).
 */
export function useMarkActivityRead() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (activityKey) => {
      await apiRequest(`/me/activity/${encodeURIComponent(activityKey)}/read`, { method: 'POST' });
    },
    onMutate: async (activityKey) => {
      // Optimistic: flip readAt + decrement counts.
      await qc.cancelQueries({ queryKey: ['me', 'activity'] });
      const nowIso = new Date().toISOString();
      const previousByFilter: Record<string, ActivityPage | undefined> = {};
      const previousInbox: Record<string, InfiniteData<ActivityPage> | undefined> = {};
      let markedRow: ActivityRow | undefined;
      for (const f of ALL_FILTERS) {
        const key = ['me', 'activity', f];
        const prev = qc.getQueryData<ActivityPage>(key);
        previousByFilter[f] = prev;
        if (prev) {
          if (!markedRow) {
            markedRow = prev.items.find((i) => i.activityKey === activityKey && !i.readAt);
          }
          qc.setQueryData<ActivityPage>(key, {
            ...prev,
            items: prev.items.map((i) =>
              i.activityKey === activityKey && !i.readAt ? { ...i, readAt: nowIso } : i,
            ),
          });
        }
        // MAJOR-3: Inbox 패널 infinite 캐시도 동일하게 patch.
        const inboxKey = ['me', 'activity', 'inbox', f];
        const inboxPrev = qc.getQueryData<InfiniteData<ActivityPage>>(inboxKey);
        previousInbox[f] = inboxPrev;
        if (inboxPrev) {
          if (!markedRow) {
            for (const pg of inboxPrev.pages) {
              const hit = pg.items.find((i) => i.activityKey === activityKey && !i.readAt);
              if (hit) {
                markedRow = hit;
                break;
              }
            }
          }
          qc.setQueryData<InfiniteData<ActivityPage>>(inboxKey, {
            ...inboxPrev,
            pages: inboxPrev.pages.map((pg) => ({
              ...pg,
              items: pg.items.map((i) =>
                i.activityKey === activityKey && !i.readAt ? { ...i, readAt: nowIso } : i,
              ),
            })),
          });
        }
      }
      const counts = qc.getQueryData<UnreadCounts>(['me', 'activity', 'unread-counts']);
      if (counts && markedRow) {
        const row = markedRow;
        qc.setQueryData<UnreadCounts>(['me', 'activity', 'unread-counts'], {
          total: Math.max(0, counts.total - 1),
          mentions: row.kind === 'mention' ? Math.max(0, counts.mentions - 1) : counts.mentions,
          replies: row.kind === 'reply' ? Math.max(0, counts.replies - 1) : counts.replies,
          reactions: row.kind === 'reaction' ? Math.max(0, counts.reactions - 1) : counts.reactions,
          directs: row.kind === 'direct' ? Math.max(0, counts.directs - 1) : counts.directs,
          friendRequests:
            row.kind === 'friend_request'
              ? Math.max(0, counts.friendRequests - 1)
              : counts.friendRequests,
        });
      }
      return { previousByFilter, previousInbox };
    },
    onError: (_err, _key, ctx) => {
      const c = ctx as {
        previousByFilter?: Record<string, ActivityPage | undefined>;
        previousInbox?: Record<string, InfiniteData<ActivityPage> | undefined>;
      };
      if (c?.previousByFilter) {
        for (const [f, data] of Object.entries(c.previousByFilter)) {
          if (data) qc.setQueryData(['me', 'activity', f], data);
        }
      }
      if (c?.previousInbox) {
        for (const [f, data] of Object.entries(c.previousInbox)) {
          if (data) qc.setQueryData(['me', 'activity', 'inbox', f], data);
        }
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'activity'] });
    },
  });
}

/**
 * S47 fix-forward (MAJOR-3): "모두 읽음" 낙관 갱신. 해당 filter 의 Inbox 패널
 * infinite 캐시 + 전체화면 ActivityPage 캐시의 모든 항목 readAt 을 즉시 채워(버튼
 * 클릭 → 즉시 반영) 서버 응답을 기다리지 않는다. 실패 시 onError 로 롤백, 성공/실패
 * 무관하게 onSettled 에서 invalidate refetch 로 서버 진실값과 정합한다.
 */
export function useMarkAllActivityRead() {
  const qc = useQueryClient();
  return useMutation<{ count: number }, Error, ActivityFilter>({
    mutationFn: (filter) =>
      apiRequest<{ count: number }>('/me/activity/read-all', {
        method: 'POST',
        body: { filter },
      }),
    onMutate: async (filter) => {
      await qc.cancelQueries({ queryKey: ['me', 'activity'] });
      const nowIso = new Date().toISOString();

      const flatKey = ['me', 'activity', filter];
      const prevFlat = qc.getQueryData<ActivityPage>(flatKey);
      if (prevFlat) {
        qc.setQueryData<ActivityPage>(flatKey, {
          ...prevFlat,
          items: prevFlat.items.map((i) => (i.readAt ? i : { ...i, readAt: nowIso })),
        });
      }

      const inboxKey = ['me', 'activity', 'inbox', filter];
      const prevInbox = qc.getQueryData<InfiniteData<ActivityPage>>(inboxKey);
      if (prevInbox) {
        qc.setQueryData<InfiniteData<ActivityPage>>(inboxKey, {
          ...prevInbox,
          pages: prevInbox.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((i) => (i.readAt ? i : { ...i, readAt: nowIso })),
          })),
        });
      }

      return { flatKey, prevFlat, inboxKey, prevInbox };
    },
    onError: (_err, _filter, ctx) => {
      const c = ctx as {
        flatKey?: string[];
        prevFlat?: ActivityPage;
        inboxKey?: string[];
        prevInbox?: InfiniteData<ActivityPage>;
      };
      if (c?.flatKey && c.prevFlat) qc.setQueryData(c.flatKey, c.prevFlat);
      if (c?.inboxKey && c.prevInbox) qc.setQueryData(c.inboxKey, c.prevInbox);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'activity'] });
    },
  });
}
