import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../design-system/primitives';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { useDmList, useCreateOrGetDm } from '../features/dms/useDms';
import { useFriendsList } from '../features/friends/useFriends';
import { WorkspaceNav } from './WorkspaceNav';
import { BottomBar } from './BottomBar';
import { ToastViewport } from '../design-system/primitives';
import { cn } from '../lib/cn';

/**
 * task-033-C/D: desktop `/dm` shell. Left column is the server rail
 * (shared with Shell.tsx) + a "친구" sidebar replacing the channel list.
 * Main column is the DM list; picking a friend starts (or resumes) a
 * DM via the existing createOrGet service.
 */
export function DmShell(): JSX.Element {
  const navigate = useNavigate();
  const { data: mine } = useMyWorkspaces();
  const workspaces = useMemo(() => mine?.workspaces ?? [], [mine]);
  // Global DM surface: first workspace is the implicit host for now.
  const primary = workspaces[0];
  const { data: dms } = useDmList(primary?.id);
  const { data: friends } = useFriendsList('accepted');
  const createDm = useCreateOrGetDm(primary?.id);
  const [query, setQuery] = useState('');
  useRealtimeConnection();
  useNotificationPreferences();

  const norm = query.trim().toLowerCase();
  const filtered = (dms?.items ?? []).filter(
    (d) => !norm || d.otherUsername.toLowerCase().includes(norm),
  );

  const start = async (userId: string): Promise<void> => {
    if (!primary) return;
    const res = await createDm.mutateAsync({ userId });
    navigate(`/w/${primary.slug}/dm/${userId}?c=${res.channelId}`);
  };

  return (
    <div data-testid="dm-shell-root" className="flex h-full bg-background text-foreground">
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <WorkspaceNav workspaces={workspaces} activeSlug={null} />
          <aside
            className="qf-channellist flex flex-col"
            style={{ width: 'var(--w-channellist)', background: 'var(--bg-panel)' }}
            data-testid="dm-side-friends"
          >
            <header className="qf-topbar">
              <h2 className="qf-topbar__title">친구</h2>
            </header>
            <nav className="flex-1 overflow-y-auto" aria-label="친구 목록">
              <Link to="/friends" data-testid="dm-side-friends-link" className="qf-channel">
                <Icon name="users" size="sm" className="text-text-muted" />
                <span className="flex-1">친구 관리</span>
              </Link>
              <div className="qf-section">
                <div className="qf-section__title">온라인 친구</div>
              </div>
              {(friends?.items ?? []).map((f) => (
                <button
                  key={f.otherUserId}
                  type="button"
                  data-testid={`dm-side-friend-${f.otherUsername}`}
                  onClick={() => start(f.otherUserId)}
                  className={cn('qf-channel w-full text-left')}
                >
                  <Avatar name={f.otherUsername} size="sm" />
                  <span className="flex-1 truncate">{f.otherUsername}</span>
                </button>
              ))}
            </nav>
          </aside>
        </div>
        <BottomBar />
      </div>
      <main
        data-testid="dm-main"
        className="flex-1 flex flex-col"
        style={{ background: 'var(--bg-app)' }}
      >
        <header className="flex items-center gap-[var(--s-3)] px-[var(--s-6)] h-[var(--h-topbar)] border-b border-border-subtle">
          <Icon name="message" size="md" />
          <div className="font-semibold text-[length:var(--fs-16)]">다이렉트 메시지</div>
          <div className="ml-auto">
            <input
              type="search"
              data-testid="dm-shell-search"
              placeholder="이름으로 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="qf-input"
            />
          </div>
        </header>
        <section className="flex-1 overflow-y-auto" data-testid="dm-shell-list">
          {filtered.length === 0 ? (
            <div className="qf-empty p-[var(--s-6)]">
              <div className="font-semibold">DM이 아직 없습니다</div>
              <div className="text-text-muted mt-[var(--s-2)]">
                {workspaces.length === 0
                  ? '먼저 /friends 에서 친구를 추가하거나, 왼쪽 나침반 아이콘으로 공개 워크스페이스를 찾아보세요.'
                  : '좌측 친구 목록에서 DM을 시작하세요.'}
              </div>
            </div>
          ) : (
            filtered.map((d) => (
              <button
                key={d.channelId}
                type="button"
                data-testid={`dm-shell-row-${d.otherUsername}`}
                onClick={() =>
                  primary && navigate(`/w/${primary.slug}/dm/${d.otherUserId}?c=${d.channelId}`)
                }
                className="w-full text-left qf-m-row"
              >
                <Avatar name={d.otherUsername} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="qf-m-row__primary">{d.otherUsername}</div>
                  <div className="qf-m-row__secondary">
                    {d.lastMessagePreview ?? '대화를 시작하세요'}
                  </div>
                </div>
                {d.unreadCount > 0 ? (
                  <div className="qf-m-row__aside">
                    <span className="qf-badge qf-badge--count">
                      {d.unreadCount > 99 ? '99+' : d.unreadCount}
                    </span>
                  </div>
                ) : null}
              </button>
            ))
          )}
        </section>
      </main>
      <ToastViewport />
    </div>
  );
}
