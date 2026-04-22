import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Avatar } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import {
  useActivityList,
  useActivityUnread,
  useMarkActivityRead,
  useMarkAllActivityRead,
  type ActivityFilter,
  type ActivityRow,
} from './useActivity';

/**
 * task-026-C: desktop /activity page. Full-surface layout (reuses the
 * qf-settings shell pattern) with qf-tabs for filter and qf-m-notif
 * rows for items (matches the mobile mockup so visual parity is
 * easier to reason about).
 */
export function ActivityPage(): JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const { data, isLoading } = useActivityList(filter);
  const { data: unread } = useActivityUnread();
  const markRead = useMarkActivityRead();
  const markAll = useMarkAllActivityRead();
  const { data: mine } = useMyWorkspaces();
  const navigate = useNavigate();

  const slugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of mine?.workspaces ?? []) m.set(w.id, w.slug);
    return m;
  }, [mine]);

  const open = (row: ActivityRow): void => {
    markRead.mutate(row.activityKey);
    const slug = slugById.get(row.workspaceId);
    if (!slug) return;
    // Channel name not available here — route to workspace; the Shell
    // loads the channel list and we highlight the message via query.
    navigate(`/w/${slug}?msg=${row.messageId}`);
  };

  const items = data?.items ?? [];

  return (
    <div
      data-testid="activity-page"
      className="h-screen flex flex-col bg-bg-app"
      style={{ background: 'var(--bg-app)' }}
    >
      <header className="flex items-center gap-[var(--s-3)] px-[var(--s-6)] h-[var(--h-topbar)] border-b border-border-subtle">
        <Icon name="bell" size="md" />
        <div className="font-semibold text-[length:var(--fs-16)]">Activity</div>
        <div className="ml-auto flex items-center gap-[var(--s-3)]">
          {unread && unread.total > 0 ? (
            <span className="qf-badge qf-badge--count" data-testid="activity-unread-total">
              {unread.total > 99 ? '99+' : unread.total}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="activity-mark-all-read"
            className="qf-btn qf-btn--subtle"
            onClick={() => markAll.mutate(filter)}
            disabled={items.every((i) => !!i.readAt)}
          >
            모두 읽음
          </button>
        </div>
      </header>
      <nav className="qf-tabs px-[var(--s-6)]" data-testid="activity-tabs">
        {(
          [
            { id: 'all', label: '전체', count: unread?.total },
            { id: 'mentions', label: '@멘션', count: unread?.mentions },
            { id: 'replies', label: '답글', count: unread?.replies },
            { id: 'reactions', label: '반응', count: unread?.reactions },
            { id: 'directs', label: 'DM', count: unread?.directs },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`activity-tab-${t.id}`}
            aria-selected={filter === t.id}
            className="qf-tabs__item"
            onClick={() => setFilter(t.id)}
          >
            {t.label}
            {t.count && t.count > 0 ? (
              <span className="ml-[var(--s-2)] qf-badge qf-badge--count">{t.count}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto" data-testid="activity-list">
        {isLoading ? (
          <div className="p-[var(--s-6)] text-text-muted">불러오는 중…</div>
        ) : items.length === 0 ? (
          <div className="qf-empty p-[var(--s-6)]">
            <div className="font-semibold text-[length:var(--fs-16)]">모든 알림을 읽었습니다</div>
            <div className="text-text-muted text-[length:var(--fs-14)] mt-[var(--s-2)]">
              새 멘션 · 답글 · 반응이 생기면 여기에 표시됩니다.
            </div>
          </div>
        ) : (
          items.map((row) => (
            <button
              key={row.activityKey}
              type="button"
              data-testid={`activity-row-${row.activityKey}`}
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
          ))
        )}
      </main>
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
