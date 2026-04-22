import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useMyWorkspaces, useMembers } from '../../features/workspaces/useWorkspaces';
import { useAuth } from '../../features/auth/AuthProvider';
import { useDmList, useCreateOrGetDm } from '../../features/dms/useDms';
import { MobileTabBar } from './MobileTabBar';

/**
 * task-027-D: mobile /dms — ScreenDMs mockup parity. qf-m-screen +
 * qf-m-topbar__titleBlock + qf-m-search + qf-m-section "All" +
 * qf-m-row list + qf-m-fab "New DM" + qf-m-tabbar.
 */
export function MobileDmList(): JSX.Element {
  const { data: mine } = useMyWorkspaces();
  const { user } = useAuth();
  const navigate = useNavigate();
  const active = useMemo(() => mine?.workspaces[0], [mine]);
  const { data: dms, isLoading } = useDmList(active?.id);
  const { data: members } = useMembers(active?.id);
  const createDm = useCreateOrGetDm(active?.id);
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  const norm = query.trim().toLowerCase();
  const rows = (dms?.items ?? []).filter(
    (d) => !norm || d.otherUsername.toLowerCase().includes(norm),
  );
  const memberCandidates = (members?.members ?? [])
    .filter((m) => m.userId !== user?.id)
    .filter((m) => !norm || m.user.username.toLowerCase().includes(norm));

  const startDm = async (otherUserId: string): Promise<void> => {
    if (!active) return;
    const res = await createDm.mutateAsync({ userId: otherUserId });
    setNewOpen(false);
    navigate(`/dms/${otherUserId}?c=${res.channelId}`);
  };

  return (
    <div data-testid="mobile-dm-list" className="qf-m-screen">
      <header className="qf-m-topbar qf-m-safe-top">
        <div />
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">Direct messages</div>
          <div className="qf-m-topbar__subtitle">{active?.name ?? ''}</div>
        </div>
        <div className="qf-m-topbar__actions">
          <button type="button" className="qf-m-topbar__action" aria-label="검색">
            <Icon name="search" size="md" />
          </button>
        </div>
      </header>

      <main className="qf-m-body">
        <div className="px-[var(--s-4)] pt-[var(--s-2)]">
          <div className="qf-m-search" data-testid="mobile-dm-search">
            <Icon name="search" size="sm" />
            <input
              type="search"
              className="qf-m-search__input"
              placeholder="DM 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="mobile-dm-search-input"
            />
          </div>
        </div>

        <div className="qf-m-section">
          <div>All</div>
        </div>

        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="qf-m-empty" data-testid="mobile-dm-empty">
            <div className="qf-m-empty__title">DM이 아직 없습니다</div>
            <div className="qf-m-empty__body">우측 하단 버튼으로 멤버와 대화를 시작하세요.</div>
          </div>
        ) : (
          rows.map((d) => (
            <button
              key={d.channelId}
              type="button"
              data-testid={`mobile-dm-row-${d.otherUsername}`}
              onClick={() => navigate(`/dms/${d.otherUserId}?c=${d.channelId}`)}
              className={cn('w-full text-left qf-m-row', d.unreadCount > 0 && 'qf-m-row--unread')}
            >
              <Avatar name={d.otherUsername} size="md" />
              <div className="min-w-0 flex-1">
                <div className="qf-m-row__primary">{d.otherUsername}</div>
                <div className="qf-m-row__secondary">
                  {d.lastMessagePreview ?? '대화를 시작하세요'}
                </div>
              </div>
              <div className="qf-m-row__aside">
                {d.lastMessageAt ? (
                  <span className="qf-m-row__time">{relTime(d.lastMessageAt)}</span>
                ) : null}
                {d.unreadCount > 0 ? (
                  <span className="qf-badge qf-badge--count">
                    {d.unreadCount > 99 ? '99+' : d.unreadCount}
                  </span>
                ) : null}
              </div>
            </button>
          ))
        )}
      </main>

      <button
        type="button"
        className="qf-m-fab"
        aria-label="새 DM"
        data-testid="mobile-dm-fab-new"
        onClick={() => setNewOpen(true)}
      >
        <Icon name="edit" size="md" />
      </button>

      <MobileTabBar
        active="dms"
        onHome={() => navigate(active ? `/w/${active.slug}` : '/')}
        onYou={() => navigate('/settings/notifications')}
        onActivity={() => navigate('/activity')}
        onDms={() => navigate('/dms')}
      />

      {newOpen ? (
        <div
          data-testid="mobile-dm-new-sheet"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[var(--z-modal,60)]"
        >
          <div className="qf-m-sheet-backdrop absolute inset-0" onClick={() => setNewOpen(false)} />
          <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0">
            <div className="qf-m-sheet__grab" aria-hidden />
            <div className="px-[var(--s-4)] pb-[var(--s-2)]">
              <div className="qf-m-search">
                <Icon name="search" size="sm" />
                <input
                  type="search"
                  className="qf-m-search__input"
                  placeholder="멤버 검색"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                  data-testid="mobile-dm-new-search-input"
                />
              </div>
            </div>
            <ul role="list" className="max-h-[50vh] overflow-y-auto">
              {memberCandidates.map((m) => (
                <li key={m.userId}>
                  <button
                    type="button"
                    data-testid={`mobile-dm-new-candidate-${m.user.username}`}
                    className="w-full text-left qf-m-row"
                    onClick={() => startDm(m.userId)}
                  >
                    <Avatar name={m.user.username} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="qf-m-row__primary">{m.user.username}</div>
                      <div className="qf-m-row__secondary">{m.role}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
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
