import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useMyWorkspaces } from '../../features/workspaces/useWorkspaces';
import {
  useActivityList,
  useActivityUnread,
  useMarkActivityRead,
  useMarkAllActivityRead,
  type ActivityFilter,
  type ActivityRow,
} from '../../features/activity/useActivity';
import { useQueryClient } from '@tanstack/react-query';
import {
  resolveActivityClick,
  ACTIVITY_TOAST,
  type ActivityClickChannel,
} from '../../features/activity/activityClick';
import { useNotifications } from '../../stores/notification-store';
import { MobileTabBar } from './MobileTabBar';
import { useKeyboardDodge } from '../../lib/useKeyboardDodge';
// 071-M5 H21 (정찰 ds-dormant ⑤): 당겨서 새로고침 — 인박스/활동 표면 한정 적용.
import { usePullToRefresh } from './usePullToRefresh';

/**
 * task-026-D: mobile /activity screen — pixel-parity with
 * mobile-mockups.jsx `ScreenActivity()`. Structure:
 *
 *   qf-m-screen
 *     qf-m-topbar (back + titleBlock)
 *     qf-m-body
 *       qf-m-segment  (4 filters)
 *       qf-m-section "오늘"
 *       qf-m-notif × N
 *       qf-m-section "지난 7일"
 *       qf-m-notif × N
 *     qf-m-fab  (mark-all-read within current filter)
 *     qf-m-tabbar (bottom nav)
 *
 * DS mobile.css is NOT modified — only consumed.
 */
export function MobileActivity(): JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const { data: mine } = useMyWorkspaces();
  const { data, isLoading, refetch: refetchList } = useActivityList(filter);
  const { data: unread, refetch: refetchUnread } = useActivityUnread();
  const markRead = useMarkActivityRead();
  const markAll = useMarkAllActivityRead();
  const navigate = useNavigate();
  useKeyboardDodge();
  // 071-M5 H21 (정찰 ds-dormant ⑤): 당겨서 새로고침 — 폴링 간격 사이 수동 갱신.
  // 목록 + 미읽 카운트를 함께 refetch 해 topbar 부제와 행이 같이 신선해진다.
  const bodyRef = useRef<HTMLElement>(null);
  const refreshing = usePullToRefresh(bodyRef, () => Promise.all([refetchList(), refetchUnread()]));

  const slugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of mine?.workspaces ?? []) m.set(w.id, w.slug);
    return m;
  }, [mine]);

  const items = data?.items ?? [];
  const groups = useMemo(() => groupByBucket(items), [items]);

  const pushToast = useNotifications((s) => s.push);

  /**
   * A-23/24(071-M0 C5): 종전엔 DM 행이 `if (slug)` 가드에 걸려 무동작, 채널 행은
   * 채널 세그먼트 없는 `/w/:slug?msg=` 로 가 빈 화면에 떨어졌다. 데스크톱과 동일한
   * resolveActivityClick 분기를 재사용하되 모바일 라우트로 사상한다:
   *  - DM → /dms/:otherUserId (모바일 DM 채팅)
   *  - 채널 → /w/:slug?ch=<channelId>&msg=<id> — MobileShell 이 채널 목록 로드 후
   *    ch 를 이름으로 해석해 실제 채널 라우트로 replace 한다(미캐시 워크스페이스도 동작).
   *  - 친구 요청 → /friends (모바일 전용 화면 존재 — 데스크톱 noop 과 다른 의도적 분기)
   */
  // 리뷰 M1: 무조건 {accessible:true} 는 삭제/권한회수 fallback(②③ 토스트)을 도달
  // 불능으로 만들었다 — 데스크톱(ActivityInboxPanel.lookupChannel)과 동일하게 캐시를
  // 조회하되, 모바일은 미방문 워크스페이스 캐시가 없는 게 정상이라 **미캐시일 때만**
  // optimistic true 로 점프한다(ch 해석은 MobileShell 이 채널 목록 로드 후 수행).
  const qc = useQueryClient();
  const lookupChannel = (
    workspaceId: string,
    channelId: string,
  ): ActivityClickChannel | undefined => {
    const channels = qc.getQueryData<{
      categories: Array<{ channels: Array<{ id: string }> }>;
      uncategorized: Array<{ id: string }>;
    }>(['workspaces', workspaceId, 'channels']);
    // 미캐시(미방문 워크스페이스) → optimistic 점프.
    if (!channels) return { accessible: true };
    const all = [
      ...(channels.uncategorized ?? []),
      ...(channels.categories?.flatMap((c) => c.channels) ?? []),
    ];
    // 캐시에 목록이 있는데 부재 → 데스크톱과 동일하게 not-found(undefined) 처리.
    return all.some((c) => c.id === channelId) ? { accessible: true } : undefined;
  };

  const open = (row: ActivityRow): void => {
    markRead.mutate(row.activityKey);
    const action = resolveActivityClick(
      row,
      row.workspaceId && row.channelId
        ? lookupChannel(row.workspaceId, row.channelId)
        : { accessible: true },
    );
    switch (action.type) {
      case 'dm-open':
        navigate(`/dms/${encodeURIComponent(action.otherUserId)}`);
        return;
      case 'thread-jump':
      case 'message-jump': {
        const slug = slugById.get(action.workspaceId);
        if (!slug) {
          pushToast({ variant: 'warning', title: ACTIVITY_TOAST.channelNotFound, ttlMs: 4000 });
          return;
        }
        const threadParam = action.type === 'thread-jump' ? '&thread=1' : '';
        navigate(
          `/w/${slug}?ch=${encodeURIComponent(action.channelId)}&msg=${encodeURIComponent(action.messageId)}${threadParam}`,
        );
        return;
      }
      default:
        if (row.kind === 'friend_request') navigate('/friends');
    }
  };

  return (
    <div data-testid="mobile-activity" className="qf-m-screen qf-m-screen--app">
      <header className="qf-m-topbar qf-m-safe-top">
        <button
          type="button"
          data-testid="mobile-activity-back"
          aria-label="뒤로"
          className="qf-m-topbar__back"
          onClick={() => navigate(-1)}
        >
          <Icon name="chevron-left" size="md" />
        </button>
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">활동</div>
          <div className="qf-m-topbar__subtitle">
            {unread && unread.total > 0 ? `읽지 않음 ${unread.total}` : '모두 읽음'}
          </div>
        </div>
        <div className="qf-m-topbar__actions">
          <button
            type="button"
            aria-label="설정"
            className="qf-m-topbar__action"
            onClick={() => navigate('/settings/notifications')}
          >
            <Icon name="settings" size="md" />
          </button>
        </div>
      </header>

      <main ref={bodyRef} className="qf-m-body" data-testid="mobile-activity-body">
        {/* H21: refreshing 동안 DS .qf-m-ptr 스피너(dormant 클래스 채택) — 완료 시 해제. */}
        {refreshing ? (
          <div
            className="qf-m-ptr"
            role="status"
            aria-label="새로고침 중"
            data-testid="mobile-activity-ptr"
          >
            <div className="qf-m-ptr__spin" aria-hidden />
          </div>
        ) : null}
        <div className="qf-m-segment" data-testid="mobile-activity-segment">
          {(
            [
              { id: 'all', label: '전체' },
              { id: 'mentions', label: '@멘션' },
              { id: 'replies', label: '답글' },
              { id: 'reactions', label: '반응' },
              { id: 'directs', label: 'DM' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              className="qf-m-segment__btn"
              aria-selected={filter === t.id}
              data-testid={`mobile-activity-tab-${t.id}`}
              onClick={() => setFilter(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : items.length === 0 ? (
          <div className="qf-m-empty" data-testid="mobile-activity-empty">
            <div className="qf-m-empty__title">모든 알림을 읽었습니다</div>
            <div className="qf-m-empty__body">
              새 멘션 · 답글 · 반응이 생기면 이곳에 표시됩니다.
            </div>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="qf-m-section">
                <div>{group.label}</div>
              </div>
              {group.rows.map((row) => (
                <button
                  key={row.activityKey}
                  type="button"
                  data-testid={`mobile-activity-row-${row.activityKey}`}
                  data-kind={row.kind}
                  data-read={row.readAt ? 'true' : 'false'}
                  onClick={() => open(row)}
                  className={cn('qf-m-notif w-full text-left', !row.readAt && 'qf-m-notif--unread')}
                >
                  <div className="qf-m-notif__avatar">
                    {/* A-25(071-M0 C5): actorId.slice 노출 금지(S47 데스크톱과 동일) —
                        actorName 사용, 결측 시 중립 폴백. */}
                    <Avatar name={row.actorName ?? '?'} size="md" />
                  </div>
                  <div>
                    <div className="qf-m-notif__head">
                      <span className="qf-m-notif__actor">
                        {row.actorName ?? '알 수 없는 사용자'}
                      </span>
                      <span className="qf-m-notif__verb">{verbFor(row)}</span>
                      <span className="qf-m-notif__time">{relTime(row.createdAt)}</span>
                    </div>
                    {row.snippet ? <div className="qf-m-notif__preview">{row.snippet}</div> : null}
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
      </main>

      <button
        type="button"
        className="qf-m-fab"
        aria-label="현재 필터의 모든 알림을 읽음 처리"
        data-testid="mobile-activity-fab-mark-all"
        onClick={() => markAll.mutate(filter)}
      >
        <Icon name="check-double" size="md" />
      </button>

      <MobileTabBar />
    </div>
  );
}

function verbFor(row: ActivityRow): string {
  switch (row.kind) {
    case 'mention':
      return '님이 회원님을 멘션함';
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

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간`;
  const days = Math.floor(hours / 24);
  return `${days}일`;
}

function groupByBucket(rows: ActivityRow[]): Array<{ label: string; rows: ActivityRow[] }> {
  const today: ActivityRow[] = [];
  const week: ActivityRow[] = [];
  const earlier: ActivityRow[] = [];
  const now = Date.now();
  for (const r of rows) {
    const delta = now - new Date(r.createdAt).getTime();
    if (delta < 86_400_000) today.push(r);
    else if (delta < 7 * 86_400_000) week.push(r);
    else earlier.push(r);
  }
  const out: Array<{ label: string; rows: ActivityRow[] }> = [];
  if (today.length) out.push({ label: '오늘', rows: today });
  if (week.length) out.push({ label: '지난 7일', rows: week });
  if (earlier.length) out.push({ label: '이전', rows: earlier });
  return out;
}
