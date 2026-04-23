import { useMemo, useState } from 'react';
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
import { MobileTabBar } from './MobileTabBar';
import { useKeyboardDodge } from '../../lib/useKeyboardDodge';

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
  const { data, isLoading } = useActivityList(filter);
  const { data: unread } = useActivityUnread();
  const markRead = useMarkActivityRead();
  const markAll = useMarkAllActivityRead();
  const navigate = useNavigate();
  useKeyboardDodge();

  const slugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of mine?.workspaces ?? []) m.set(w.id, w.slug);
    return m;
  }, [mine]);

  const items = data?.items ?? [];
  const groups = useMemo(() => groupByBucket(items), [items]);

  const open = (row: ActivityRow): void => {
    markRead.mutate(row.activityKey);
    const slug = slugById.get(row.workspaceId);
    if (slug) navigate(`/w/${slug}?msg=${row.messageId}`);
  };

  return (
    <div data-testid="mobile-activity" className="qf-m-screen">
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
          <div className="qf-m-topbar__title">Activity</div>
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

      <main className="qf-m-body" data-testid="mobile-activity-body">
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
                    <Avatar name={row.actorId.slice(0, 2)} size="md" />
                  </div>
                  <div>
                    <div className="qf-m-notif__head">
                      <span className="qf-m-notif__actor">{row.actorId.slice(0, 8)}</span>
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

      <MobileTabBar
        active="activity"
        onHome={() => navigate('/')}
        onYou={() => navigate('/settings/notifications')}
        onDms={() => navigate('/dms')}
      />
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
