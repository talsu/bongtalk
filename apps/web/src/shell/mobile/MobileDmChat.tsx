import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { useMyWorkspaces, useMembers } from '../../features/workspaces/useWorkspaces';
import { useDmByUser } from '../../features/dms/useDms';
import { MobileMessages } from './MobileMessages';
import { MobileTabBar } from './MobileTabBar';

/**
 * task-027-D: mobile /dms/:userId — 1:1 chat reusing MobileMessages.
 */
export function MobileDmChat(): JSX.Element {
  const { userId } = useParams<{ userId: string }>();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { data: mine } = useMyWorkspaces();
  const active = useMemo(() => mine?.workspaces[0], [mine]);
  const { data: members } = useMembers(active?.id);
  const other = (members?.members ?? []).find((m) => m.userId === userId);

  const hintedChannelId = sp.get('c');
  const { data: byUser } = useDmByUser(active?.id, hintedChannelId ? undefined : userId);
  const channelId = hintedChannelId ?? byUser?.channelId ?? null;

  return (
    <div data-testid="mobile-dm-chat" className="qf-m-screen">
      <header className="qf-m-topbar qf-m-safe-top">
        <button
          type="button"
          data-testid="mobile-dm-back"
          aria-label="뒤로"
          className="qf-m-topbar__back"
          onClick={() => navigate('/dms')}
        >
          <Icon name="chevron-left" size="md" />
        </button>
        <div className="qf-m-topbar__titleBlock flex items-center gap-[var(--s-2)]">
          <Avatar name={other?.user.username ?? userId?.slice(0, 2) ?? '?'} size="sm" />
          <div>
            <div className="qf-m-topbar__title">{other?.user.username ?? '…'}</div>
            <div className="qf-m-topbar__subtitle">{active?.name ?? ''}</div>
          </div>
        </div>
        <div />
      </header>
      {active && channelId ? (
        <MobileMessages
          workspaceId={active.id}
          workspaceSlug={active.slug}
          channelId={channelId}
          channelName="dm"
        />
      ) : (
        <div className="qf-m-empty">
          <div className="qf-m-empty__body">불러오는 중…</div>
        </div>
      )}
      <MobileTabBar
        active="home"
        onHome={() => navigate(active ? `/w/${active.slug}` : '/')}
        onSettings={() => navigate('/settings/notifications')}
        onActivity={() => navigate('/activity')}
      />
    </div>
  );
}
