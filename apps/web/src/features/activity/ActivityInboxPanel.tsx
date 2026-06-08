import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Icon, Avatar } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useNotifications } from '../../stores/notification-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import {
  useActivityInbox,
  useActivityUnread,
  useMarkActivityRead,
  useMarkAllActivityRead,
  type ActivityRow,
} from './useActivity';
import { useDelayedLoading } from './useDelayedLoading';
import { INBOX_TABS, type InboxTab, tabToFilter, emptyCopyForTab } from './inboxTabs';
import { resolveActivityClick, ACTIVITY_TOAST, type ActivityClickChannel } from './activityClick';

/**
 * S47 (FR-MN-13): Activity Inbox 패널.
 *
 * 전용 패널(role="complementary"). 탭(전체/멘션/스레드/DM)은 tablist/tab/tabpanel
 * ARIA 패턴 + roving tabIndex(ArrowLeft/Right/Home/End)를 따른다. 탭별 empty 카피 +
 * .qf-skel 3행(200ms 지연·aria-busy) + 항목 클릭 fallback(채널 삭제/권한 회수 toast +
 * 패널 유지, DM open, 스레드 답글 jump, 멘션 jump) + 항목별/전체 읽음 + cursor
 * 무한스크롤(IntersectionObserver).
 *
 * S47 fix-forward 반영:
 *  - BLOCKER-8: qf-skeleton→qf-skel(DS 실재), raw width px→page-scoped 변수.
 *  - a11y A-1 roving tablist / A-2 actorName 접근명 / A-3 skeleton aria-busy+status,
 *    B-1 aside 한국어 라벨 / B-2 tabpanel tabIndex=0 / B-3 empty role=status.
 *  - MAJOR-4 DM open 라우트.
 *
 * 기존 ActivityPage(전체화면)와 병존한다(같은 /me/activity 경로 재사용). 신규 DS
 * 클래스 0 — 기존 qf-* + 토큰만 쓴다.
 */
export function ActivityInboxPanel(): JSX.Element {
  const [tab, setTab] = useState<InboxTab>('all');
  const filter = tabToFilter(tab);
  const query = useActivityInbox(filter);
  const { data: unread } = useActivityUnread();
  const markRead = useMarkActivityRead();
  const markAll = useMarkAllActivityRead();
  const { data: mine } = useMyWorkspaces();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pushToast = useNotifications((s) => s.push);

  const showSkeleton = useDelayedLoading(query.isLoading);

  // A-1 roving tabIndex: 탭 버튼 ref 로 키보드 이동 시 focus 를 옮긴다.
  const tabRefs = useRef<Record<InboxTab, HTMLButtonElement | null>>({
    all: null,
    mentions: null,
    threads: null,
    dms: null,
  });

  const slugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of mine?.workspaces ?? []) m.set(w.id, w.slug);
    return m;
  }, [mine]);

  const items = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.items), [query.data]);

  /**
   * 채널 접근성 조회 — 채널 목록 캐시에 존재하면 accessible, 없으면 undefined
   * (삭제/미가시 → channel-not-found). no-access 분기는 서버 응답 기반이라 현재
   * 캐시로는 삭제와 구분하지 못해 보수적으로 not-found 로 수렴한다(클릭 fallback
   * 토스트는 두 경로 모두 패널을 유지하므로 UX 안전 — resolveActivityClick 단위
   * 검증은 양쪽을 모두 커버).
   */
  const lookupChannel = useCallback(
    (workspaceId: string, channelId: string): ActivityClickChannel | undefined => {
      const channels = qc.getQueryData<{
        categories: Array<{ channels: Array<{ id: string }> }>;
        uncategorized: Array<{ id: string }>;
      }>(['workspaces', workspaceId, 'channels']);
      if (!channels) return undefined;
      const all = [
        ...(channels.uncategorized ?? []),
        ...(channels.categories?.flatMap((c) => c.channels) ?? []),
      ];
      return all.some((c) => c.id === channelId) ? { accessible: true } : undefined;
    },
    [qc],
  );

  const open = useCallback(
    (row: ActivityRow): void => {
      markRead.mutate(row.activityKey);
      const action = resolveActivityClick(
        row,
        row.workspaceId && row.channelId
          ? lookupChannel(row.workspaceId, row.channelId)
          : undefined,
      );
      switch (action.type) {
        case 'channel-not-found':
          pushToast({ variant: 'warning', title: ACTIVITY_TOAST.channelNotFound, ttlMs: 4000 });
          return; // 패널 유지.
        case 'no-access':
          pushToast({ variant: 'warning', title: ACTIVITY_TOAST.noAccess, ttlMs: 4000 });
          return; // 패널 유지.
        case 'noop':
          return;
        case 'dm-open':
          // MAJOR-4: DM 은 워크스페이스 점프가 아니라 DM 라우트로(global DM 포함).
          navigate(`/dm/${encodeURIComponent(action.otherUserId)}`);
          return;
        case 'thread-jump':
        case 'message-jump': {
          const slug = slugById.get(action.workspaceId);
          if (!slug) return;
          // D07 jump 가드 재사용: ?msg= 로 점프하면 MessageColumn 이 around 로드 +
          // 2초 하이라이트를 적용한다. 스레드 답글은 thread 파라미터로 패널 오픈을
          // 신호한다(채널 이동 → Thread Panel → 스크롤 → 2초 하이라이트).
          const threadParam = action.type === 'thread-jump' ? '&thread=1' : '';
          navigate(`/w/${slug}?msg=${encodeURIComponent(action.messageId)}${threadParam}`);
          return;
        }
      }
    },
    [markRead, lookupChannel, pushToast, slugById, navigate],
  );

  // 무한스크롤: 센티넬이 보이면 다음 페이지 로드.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const tabCount = (t: InboxTab): number | undefined => {
    if (!unread) return undefined;
    switch (t) {
      case 'all':
        return unread.total;
      case 'mentions':
        return unread.mentions;
      case 'threads':
        return unread.replies;
      case 'dms':
        return unread.directs;
    }
  };

  /**
   * A-1: roving tablist 키보드 이동. ArrowLeft/Right 로 이전/다음 탭, Home/End 로
   * 처음/끝 탭으로 선택 + focus 를 옮긴다(WAI-ARIA tabs 패턴).
   */
  const onTabKeyDown = (e: React.KeyboardEvent, current: InboxTab): void => {
    const order = INBOX_TABS.map((t) => t.id);
    const idx = order.indexOf(current);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % order.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + order.length) % order.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = order.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = order[nextIdx];
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside
      id="activity-inbox-panel"
      role="complementary"
      aria-label="알림 인박스"
      data-testid="activity-inbox-panel"
      className="h-full flex flex-col"
      style={{
        // BLOCKER-8: raw 320px 제거 → page-scoped CSS 변수(폴백 320px).
        width: 'var(--w-activity-panel, 320px)',
        flexShrink: 0,
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--divider)',
      }}
    >
      <header className="flex items-center gap-[var(--s-3)] px-[var(--s-4)] h-[var(--h-topbar)] border-b border-border-subtle">
        <Icon name="bell" size="md" />
        <div className="font-semibold text-[length:var(--fs-15)]">알림</div>
        <button
          type="button"
          data-testid="activity-inbox-mark-all-read"
          className="ml-auto qf-btn qf-btn--ghost"
          onClick={() => markAll.mutate(filter)}
          disabled={items.length === 0 || items.every((i) => !!i.readAt)}
        >
          모두 읽음
        </button>
      </header>

      <div role="tablist" aria-label="알림 필터" className="qf-tabs px-[var(--s-3)]">
        {INBOX_TABS.map((t) => {
          const count = tabCount(t.id);
          const selected = tab === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`activity-inbox-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`activity-inbox-panel-${t.id}`}
              // A-1: 활성 탭만 tabIndex=0, 나머지 -1(roving).
              tabIndex={selected ? 0 : -1}
              data-testid={`activity-inbox-tab-${t.id}`}
              className="qf-tabs__item"
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, t.id)}
            >
              {t.label}
              {count && count > 0 ? (
                <span aria-hidden="true" className="ml-[var(--s-2)] qf-badge qf-badge--count">
                  {count > 99 ? '99+' : count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`activity-inbox-panel-${tab}`}
        aria-labelledby={`activity-inbox-tab-${tab}`}
        // B-2: tabpanel 은 포커스 가능(키보드로 패널 내용에 진입).
        tabIndex={0}
        // A-3: 로딩 중 aria-busy 로 스크린리더에 진행 알림.
        aria-busy={query.isLoading}
        data-testid="activity-inbox-list"
        className="flex-1 overflow-y-auto"
      >
        {showSkeleton ? (
          <div
            data-testid="activity-inbox-skeleton"
            role="status"
            aria-live="polite"
            aria-label="알림을 불러오는 중"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="qf-skel"
                aria-hidden="true"
                style={{
                  height: 'var(--s-10)',
                  margin: 'var(--s-3) var(--s-4)',
                  borderRadius: 'var(--r-md)',
                }}
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div
            className="qf-empty p-[var(--s-6)]"
            data-testid="activity-inbox-empty"
            // B-3: empty 상태 통지(role=status aria-live).
            role="status"
            aria-live="polite"
          >
            <div className="text-text-muted text-[length:var(--fs-14)]">{emptyCopyForTab(tab)}</div>
          </div>
        ) : (
          <>
            {items.map((row) => {
              const name = displayName(row);
              return (
                <button
                  key={row.activityKey}
                  type="button"
                  data-testid={`activity-inbox-row-${row.activityKey}`}
                  data-kind={row.kind}
                  data-read={row.readAt ? 'true' : 'false'}
                  // A-2: 접근명 = "{actorName}{verb} — {상대시간}"(actorId.slice 제거).
                  aria-label={`${name}${verbFor(row)} — ${relativeTime(row.createdAt)}`}
                  onClick={() => open(row)}
                  className={cn('qf-m-notif w-full text-left', !row.readAt && 'qf-m-notif--unread')}
                >
                  <div className="qf-m-notif__avatar">
                    <Avatar name={name} size="md" />
                  </div>
                  <div>
                    <div className="qf-m-notif__head">
                      <span className="qf-m-notif__actor">{name}</span>
                      <span className="qf-m-notif__verb">{verbFor(row)}</span>
                    </div>
                    {row.snippet ? <div className="qf-m-notif__preview">{row.snippet}</div> : null}
                  </div>
                </button>
              );
            })}
            <div ref={sentinelRef} style={{ height: '1px' }} aria-hidden="true" />
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * A-2: 표시명/접근명 — API read-time join 한 actorName 을 쓰고, 누락(삭제 사용자
 * 등)이면 중립 폴백("알 수 없는 사용자")으로 둔다. actorId.slice 노출 금지.
 */
function displayName(row: ActivityRow): string {
  return row.actorName?.trim() || '알 수 없는 사용자';
}

function verbFor(row: ActivityRow): string {
  switch (row.kind) {
    case 'mention':
      // FR-MN-10 (066 / S93): 키워드 알림 유래 멘션은 별도 레이블로 분기한다(등록 키워드가
      // 본문에 어절 정확 일치). 일반 @멘션과 구분해 사용자가 알림 사유를 인지하게 한다.
      return row.keyword ? '님의 메시지에 키워드 알림이 있음' : '님이 회원님을 멘션함';
    case 'reply':
      return '님이 답글을 남김';
    case 'reaction':
      return `님이 ${row.snippet || '반응'} 을 남김`;
    case 'direct':
      return '님이 DM을 보냄';
    case 'friend_request':
      return '님이 친구 요청을 보냄';
  }
}

/**
 * 접근명용 상대 시간(한국어). vi.setSystemTime 정합 — Date.now 기준. 분/시/일 단위로
 * 절삭하고, 미래/방금은 "방금"으로 수렴한다.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}
