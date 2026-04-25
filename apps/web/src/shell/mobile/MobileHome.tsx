import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { useAuth } from '../../features/auth/AuthProvider';
import { useMyWorkspaces, useMembers } from '../../features/workspaces/useWorkspaces';
import { useChannelList } from '../../features/channels/useChannels';
import { useDmList } from '../../features/dms/useDms';
import { useFriendsList } from '../../features/friends/useFriends';
import { useRealtimeConnection } from '../../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../../features/notifications/useNotificationPreferences';
import { usePresence } from '../../features/realtime/usePresence';
import { MobileTabBar } from './MobileTabBar';
import { MobileOverlay } from './MobileOverlay';
import { cn } from '../../lib/cn';

/**
 * task-035-E: mobile Home screen split — narrow 76px rail (DM + workspace
 * avatars + create + discover) on the left, wider content column on the
 * right. Rail state is derived from ?ws= or ?dm= in the URL so a shallow
 * push keeps both halves responsive without remounting either.
 *
 * DS mobile.css is NOT modified — the rail + content use existing qf-m-*
 * classes + inline CSS vars. Chat itself is rendered via MobileOverlay
 * when ?chat=<channelId> is in the URL.
 */
export function MobileHome(): JSX.Element {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const { user: me } = useAuth();
  useRealtimeConnection();
  useNotificationPreferences();
  const { data: mine } = useMyWorkspaces();
  const workspaces = useMemo(() => mine?.workspaces ?? [], [mine]);

  // Rail selection: 'dm' or workspaceId.
  const selected = sp.get('ws') ?? (sp.get('dm') === '1' ? 'dm' : 'dm');
  const chatChannelId = sp.get('chat');
  const chatOther = sp.get('to');

  const active = workspaces.find((w) => w.id === selected);
  const { data: channels } = useChannelList(active?.id);
  // DM list is workspace-agnostic post-034; pass undefined so the
  // query fires for zero-workspace users too.
  const { data: dms } = useDmList(undefined);
  const { data: friends } = useFriendsList('accepted');
  const { data: members } = useMembers(active?.id);
  const { onlineUserIds } = usePresence(active?.id);

  const selectRail = (id: 'dm' | string): void => {
    const next = new URLSearchParams(sp);
    if (id === 'dm') {
      next.set('dm', '1');
      next.delete('ws');
    } else {
      next.set('ws', id);
      next.delete('dm');
    }
    next.delete('chat');
    next.delete('to');
    setSp(next, { replace: true });
  };

  const openChat = (channelId: string, otherOrChannelName: string): void => {
    const next = new URLSearchParams(sp);
    next.set('chat', channelId);
    next.set('to', otherOrChannelName);
    setSp(next, { replace: false });
  };

  const closeChat = (): void => {
    const next = new URLSearchParams(sp);
    next.delete('chat');
    next.delete('to');
    setSp(next, { replace: false });
  };

  return (
    <div data-testid="mobile-home" className="qf-m-screen">
      <div className="flex-1 flex min-h-0" data-testid="mobile-home-split">
        {/* Narrow rail */}
        <aside
          data-testid="mobile-home-rail"
          aria-label="rail"
          className="flex flex-col items-center gap-[var(--s-2)] py-[var(--s-3)] overflow-y-auto qf-m-safe-top"
          style={{
            width: '76px',
            background: 'var(--bg-serverlist, var(--bg-panel))',
            borderRight: '1px solid var(--divider)',
          }}
        >
          <RailBtn
            testId="mobile-rail-dm"
            label="DM"
            icon="message"
            selected={selected === 'dm'}
            onClick={() => selectRail('dm')}
          />
          <div
            aria-hidden
            style={{ height: '1px', width: '40px', background: 'var(--divider)', margin: '4px 0' }}
          />
          {workspaces.map((w) => (
            <RailAvatar
              key={w.id}
              testId={`mobile-rail-ws-${w.slug}`}
              label={w.name}
              selected={selected === w.id}
              onClick={() => selectRail(w.id)}
            />
          ))}
          <Link
            to="/w/new"
            data-testid="mobile-rail-new"
            aria-label="새 워크스페이스"
            className="grid place-items-center"
            style={{
              width: '48px',
              height: '48px',
              borderRadius: 'var(--r-pill)',
              border: '1px dashed var(--divider)',
              color: 'var(--text-muted)',
            }}
          >
            <Icon name="plus" size="sm" />
          </Link>
          <Link
            to="/discover"
            data-testid="mobile-rail-discover"
            aria-label="찾기"
            className="grid place-items-center"
            style={{
              width: '48px',
              height: '48px',
              borderRadius: 'var(--r-pill)',
              color: 'var(--text-muted)',
            }}
          >
            <Icon name="compass" size="sm" />
          </Link>
        </aside>

        {/* Wider content — DM list or channel list */}
        <main className="flex-1 min-w-0 flex flex-col" data-testid="mobile-home-content">
          {selected === 'dm' ? (
            <DmContent
              friends={friends?.items ?? []}
              dms={dms?.items ?? []}
              onOpen={(_otherUserId, channelId, username) => openChat(channelId, username)}
              onStart={(userId, username) => navigate(`/dm?new=${userId}&name=${username}`)}
            />
          ) : active ? (
            <WorkspaceContent
              workspaceName={active.name}
              channels={
                [
                  ...(channels?.uncategorized ?? []).map((c) => ({
                    ...c,
                    category: null as string | null,
                  })),
                  ...(channels?.categories ?? []).flatMap((cat) =>
                    cat.channels.map((c) => ({ ...c, category: cat.name })),
                  ),
                ] as Array<{ id: string; name: string; category: string | null }>
              }
              onOpen={(channelId, channelName) => openChat(channelId, channelName)}
              memberCount={members?.members.length ?? 0}
              onlineCount={members?.members.filter((m) => onlineUserIds.has(m.userId)).length ?? 0}
            />
          ) : (
            <div className="qf-m-empty">
              <div className="qf-m-empty__title">워크스페이스를 선택하세요</div>
            </div>
          )}
        </main>
      </div>

      <MobileTabBar
        active="home"
        onHome={() => navigate('/')}
        onSettings={() => navigate('/settings/notifications')}
        onActivity={() => navigate('/activity')}
      />

      {chatChannelId ? (
        <MobileOverlay
          data-testid="mobile-home-chat-overlay"
          title={chatOther ?? '대화'}
          onClose={closeChat}
          /* DM rail (selected==='dm') always opens the channel as a
             Global DM (workspaceId=null). Workspace channels still
             pass through their host workspace so member/role lookup +
             unread mark-read keep working. */
          workspaceId={selected === 'dm' ? null : (active?.id ?? null)}
          workspaceSlug={selected === 'dm' ? null : (active?.slug ?? null)}
          channelId={chatChannelId}
          channelName={chatOther ?? 'dm'}
          extraNames={
            selected === 'dm'
              ? new Map([
                  ...(me?.id && me?.username ? ([[me.id, me.username]] as [string, string][]) : []),
                  ...(friends?.items ?? []).map(
                    (f) => [f.otherUserId, f.otherUsername] as [string, string],
                  ),
                ])
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function RailBtn({
  testId,
  label,
  icon,
  selected,
  onClick,
}: {
  testId: string;
  label: string;
  icon: 'message' | 'compass' | 'plus';
  selected?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-selected={selected ? 'true' : 'false'}
      onClick={onClick}
      className={cn('grid place-items-center')}
      style={{
        width: '48px',
        height: '48px',
        borderRadius: selected ? 'var(--r-md)' : 'var(--r-pill)',
        background: selected ? 'var(--accent)' : 'var(--bg-elevated)',
        color: selected ? 'var(--text-onAccent)' : 'var(--text)',
        transition: 'border-radius var(--dur-fast) var(--ease-standard)',
      }}
    >
      <Icon name={icon} size="md" />
    </button>
  );
}

function RailAvatar({
  testId,
  label,
  selected,
  onClick,
}: {
  testId: string;
  label: string;
  selected?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-selected={selected ? 'true' : 'false'}
      onClick={onClick}
      className="grid place-items-center"
      style={{
        width: '48px',
        height: '48px',
        borderRadius: selected ? 'var(--r-md)' : 'var(--r-pill)',
        transition: 'border-radius var(--dur-fast) var(--ease-standard)',
        boxShadow: selected ? '0 0 0 2px var(--accent)' : 'none',
      }}
    >
      <Avatar name={label} size="md" />
    </button>
  );
}

function DmContent({
  friends,
  dms,
  onOpen,
  onStart,
}: {
  friends: Array<{ otherUserId: string; otherUsername: string }>;
  dms: Array<{
    channelId: string;
    otherUserId: string;
    otherUsername: string;
    lastMessagePreview: string | null;
  }>;
  onOpen: (otherUserId: string, channelId: string, username: string) => void;
  onStart: (userId: string, username: string) => void;
}): JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="qf-m-section">
        <div>DM 진행중</div>
      </div>
      {dms.length === 0 ? (
        <div className="qf-m-empty" data-testid="mobile-home-dm-empty">
          <div className="qf-m-empty__body">진행중인 DM이 없습니다</div>
        </div>
      ) : (
        dms.map((d) => (
          <button
            key={d.channelId}
            type="button"
            data-testid={`mobile-home-dm-${d.otherUsername}`}
            onClick={() => onOpen(d.otherUserId, d.channelId, d.otherUsername)}
            className="qf-m-row w-full text-left"
          >
            <Avatar name={d.otherUsername} size="md" />
            <div className="min-w-0 flex-1">
              <div className="qf-m-row__primary">{d.otherUsername}</div>
              <div className="qf-m-row__secondary">
                {d.lastMessagePreview ?? '대화를 시작하세요'}
              </div>
            </div>
          </button>
        ))
      )}
      <div className="qf-m-section">
        <div>친구</div>
      </div>
      {friends.length === 0 ? (
        <div className="qf-m-empty">
          <div className="qf-m-empty__body">친구가 아직 없습니다</div>
        </div>
      ) : (
        friends.map((f) => (
          <button
            key={f.otherUserId}
            type="button"
            data-testid={`mobile-home-friend-${f.otherUsername}`}
            onClick={() => onStart(f.otherUserId, f.otherUsername)}
            className="qf-m-row w-full text-left"
          >
            <Avatar name={f.otherUsername} size="md" />
            <div className="min-w-0 flex-1">
              <div className="qf-m-row__primary">{f.otherUsername}</div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}

function WorkspaceContent({
  workspaceName,
  channels,
  onOpen,
  memberCount,
  onlineCount,
}: {
  workspaceName: string;
  channels: Array<{ id: string; name: string; category: string | null }>;
  onOpen: (channelId: string, channelName: string) => void;
  memberCount: number;
  onlineCount: number;
}): JSX.Element {
  const grouped = channels.reduce<Record<string, Array<{ id: string; name: string }>>>((acc, c) => {
    const key = c.category ?? '채널';
    acc[key] = acc[key] ?? [];
    acc[key].push({ id: c.id, name: c.name });
    return acc;
  }, {});
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="qf-m-section">
        <div>
          {workspaceName} · 온라인 {onlineCount}/{memberCount}
        </div>
      </div>
      {Object.entries(grouped).map(([cat, list]) => (
        <div key={cat}>
          <div className="qf-m-section">
            <div>{cat}</div>
          </div>
          {list.map((ch) => (
            <button
              key={ch.id}
              type="button"
              data-testid={`mobile-home-channel-${ch.name}`}
              onClick={() => onOpen(ch.id, ch.name)}
              className="qf-m-row w-full text-left"
            >
              <Icon name="hash" size="sm" className="text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="qf-m-row__primary">{ch.name}</div>
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
