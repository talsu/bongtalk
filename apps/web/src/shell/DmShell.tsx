import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Avatar, Icon } from '../design-system/primitives';
import { useAuth } from '../features/auth/AuthProvider';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { useDmList, useCreateOrGetDm, useDmByUser } from '../features/dms/useDms';
import { useFriendsList } from '../features/friends/useFriends';
import { WorkspaceNav } from './WorkspaceNav';
import { BottomBar } from './BottomBar';
import { MessageColumn } from './MessageColumn';
import { ToastViewport } from '../design-system/primitives';
import { cn } from '../lib/cn';

/**
 * task-033-C/D + follow: desktop Global DM surface. Three-column layout
 * mirroring Shell's (rail + list + message column). Route shape is
 * workspace-free — `/dm` for the list, `/dm/:userId` for a selected
 * conversation. The old `/w/:slug/dm[/:userId]` URLs redirect into here.
 *
 * Selecting a friend/DM row updates the `:userId` param in place; the
 * right column swaps from the DM list to `MessageColumn` without a
 * full-page navigate, so the left rail + friends pane stay mounted.
 */
export function DmShell(): JSX.Element {
  const { userId: routeUserId } = useParams<{ userId?: string }>();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const { data: mine } = useMyWorkspaces();
  const workspaces = useMemo(() => mine?.workspaces ?? [], [mine]);
  // The message path at /workspaces/:wsId/channels/:chid/messages still
  // needs a workspace on the URL for the WorkspaceMemberGuard — the
  // server resolves the DM channel by id alone via the DIRECT bypass in
  // ChannelAccessGuard, so any workspace the caller is a member of
  // works. Pick the first one as the "host" for bookkeeping.
  const primary = workspaces[0];
  const { data: dms } = useDmList(primary?.id);
  const { data: friends } = useFriendsList('accepted');
  const createDm = useCreateOrGetDm(primary?.id);
  const [query, setQuery] = useState('');
  useRealtimeConnection();
  useNotificationPreferences();

  // Resolve the DM channel for the selected :userId. The /me/dms POST
  // is idempotent — safe to call on every route change that lands on a
  // user without a known channelId.
  const { data: byUser } = useDmByUser(primary?.id, routeUserId);
  const selectedChannelId = byUser?.channelId ?? null;

  useEffect(() => {
    // If the user picked a friend who has never been DM'd, reserve the
    // channel now so MessageColumn has a channelId to render against.
    if (!routeUserId || selectedChannelId || byUser === undefined) return;
    void createDm.mutateAsync({ userId: routeUserId }).catch(() => undefined);
    // mutation invalidation will refresh byUser via queryKey side-effect
  }, [routeUserId, selectedChannelId, byUser, createDm]);

  const norm = query.trim().toLowerCase();
  const filtered = (dms?.items ?? []).filter(
    (d) => !norm || d.otherUsername.toLowerCase().includes(norm),
  );

  const selectedFriend = useMemo(() => {
    if (!routeUserId) return null;
    const fromFriends = (friends?.items ?? []).find((f) => f.otherUserId === routeUserId);
    if (fromFriends) return { userId: routeUserId, username: fromFriends.otherUsername };
    const fromDms = (dms?.items ?? []).find((d) => d.otherUserId === routeUserId);
    if (fromDms) return { userId: routeUserId, username: fromDms.otherUsername };
    return { userId: routeUserId, username: '' };
  }, [routeUserId, friends, dms]);

  // DM author map: MessageList falls back to `useMembers(primary.id)`
  // which never sees the other participant when they belong to a
  // different workspace (or no workspace at all). Supply the pair
  // here so MessageItem stops rendering the other side as "unknown".
  const extraNames = useMemo(() => {
    const m = new Map<string, string>();
    if (me?.id && me?.username) m.set(me.id, me.username);
    if (selectedFriend?.userId && selectedFriend.username)
      m.set(selectedFriend.userId, selectedFriend.username);
    return m;
  }, [me, selectedFriend]);

  const openDm = (userId: string): void => {
    navigate(`/dm/${userId}`);
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
              <h2 className="qf-topbar__title">다이렉트 메시지</h2>
            </header>
            <div className="px-[var(--s-3)] py-[var(--s-2)]">
              <input
                type="search"
                data-testid="dm-shell-search"
                placeholder="이름으로 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="qf-input w-full"
              />
            </div>
            <nav className="flex-1 overflow-y-auto" aria-label="DM + 친구 목록">
              <Link to="/friends" data-testid="dm-side-friends-link" className="qf-channel">
                <Icon name="users" size="sm" className="text-text-muted" />
                <span className="flex-1">친구 관리</span>
              </Link>
              {filtered.length > 0 ? (
                <div className="qf-section">
                  <div className="qf-section__title">대화 목록</div>
                </div>
              ) : null}
              {filtered.map((d) => (
                <button
                  key={d.channelId}
                  type="button"
                  data-testid={`dm-shell-row-${d.otherUsername}`}
                  onClick={() => openDm(d.otherUserId)}
                  aria-selected={d.otherUserId === routeUserId}
                  className={cn(
                    'qf-channel w-full text-left',
                    d.otherUserId === routeUserId && 'qf-channel--active',
                  )}
                >
                  <Avatar name={d.otherUsername} size="sm" />
                  <span className="flex-1 truncate">{d.otherUsername}</span>
                  {d.unreadCount > 0 ? (
                    <span className="qf-badge qf-badge--count">
                      {d.unreadCount > 99 ? '99+' : d.unreadCount}
                    </span>
                  ) : null}
                </button>
              ))}
              {(friends?.items ?? []).length > 0 ? (
                <div className="qf-section">
                  <div className="qf-section__title">친구</div>
                </div>
              ) : null}
              {(friends?.items ?? []).map((f) => (
                <button
                  key={f.otherUserId}
                  type="button"
                  data-testid={`dm-side-friend-${f.otherUsername}`}
                  onClick={() => openDm(f.otherUserId)}
                  aria-selected={f.otherUserId === routeUserId}
                  className={cn(
                    'qf-channel w-full text-left',
                    f.otherUserId === routeUserId && 'qf-channel--active',
                  )}
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
      {routeUserId && selectedChannelId && primary ? (
        <MessageColumn
          workspaceId={primary.id}
          workspaceSlug={primary.slug}
          channelId={selectedChannelId}
          channelName={selectedFriend?.username || '…'}
          channelTopic={null}
          extraNames={extraNames}
        />
      ) : routeUserId ? (
        <main className="qf-empty flex-1" data-testid="dm-shell-loading">
          <div className="qf-empty__title">대화를 준비 중…</div>
        </main>
      ) : (
        <main className="qf-empty flex-1" data-testid="dm-shell-empty">
          <div className="qf-empty__title">
            {workspaces.length === 0 ? '먼저 친구를 추가해보세요' : '대화할 친구를 선택하세요'}
          </div>
          <div className="qf-empty__body">
            {workspaces.length === 0
              ? '/friends 에서 친구를 추가하거나, 왼쪽 나침반으로 공개 워크스페이스를 찾아보세요.'
              : '좌측 목록에서 친구 또는 기존 대화를 클릭하세요.'}
          </div>
        </main>
      )}
      <ToastViewport />
    </div>
  );
}
