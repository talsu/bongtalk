import { useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { useAuth } from '../../features/auth/AuthProvider';
import { useDmByUser, useCreateOrGetDm } from '../../features/dms/useDms';
import { useFriendsList } from '../../features/friends/useFriends';
import { MobileMessages } from './MobileMessages';
import { MobileTabBar } from './MobileTabBar';

/**
 * Mobile /dms/:userId — Global DM chat. Workspace-free end to end:
 * the chat routes through /me/dms/:channelId/messages so a
 * zero-workspace user can DM a friend, and the topbar subtitle shows
 * the friend's username instead of a workspace name.
 *
 * If the URL didn't carry a `?c=<channelId>` hint and there is no
 * existing DM row, an effect calls createOrGet so MobileMessages can
 * render against a real channelId without a manual page reload.
 */
export function MobileDmChat(): JSX.Element {
  const { userId } = useParams<{ userId: string }>();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const { data: friends } = useFriendsList('accepted');

  const hintedChannelId = sp.get('c');
  const { data: byUser } = useDmByUser(undefined, hintedChannelId ? undefined : userId);
  const createDm = useCreateOrGetDm(undefined);
  const channelId = hintedChannelId ?? byUser?.channelId ?? null;

  useEffect(() => {
    if (!userId || channelId || byUser === undefined) return;
    void createDm.mutateAsync({ userId }).catch(() => undefined);
  }, [userId, channelId, byUser, createDm]);

  const friend = useMemo(() => {
    return (friends?.items ?? []).find((f) => f.otherUserId === userId);
  }, [friends, userId]);
  const otherUsername = friend?.otherUsername ?? userId?.slice(0, 6) ?? '…';

  const extraNames = useMemo(() => {
    const m = new Map<string, string>();
    if (me?.id && me?.username) m.set(me.id, me.username);
    if (userId && friend?.otherUsername) m.set(userId, friend.otherUsername);
    return m;
  }, [me, userId, friend]);

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
          <Avatar name={otherUsername} size="sm" />
          <div>
            <div className="qf-m-topbar__title">{otherUsername}</div>
            <div className="qf-m-topbar__subtitle">다이렉트 메시지</div>
          </div>
        </div>
        <div />
      </header>
      {channelId ? (
        <MobileMessages
          workspaceId={null}
          workspaceSlug={null}
          channelId={channelId}
          channelName={otherUsername}
          extraNames={extraNames}
        />
      ) : (
        <div className="qf-m-empty">
          <div className="qf-m-empty__body">불러오는 중…</div>
        </div>
      )}
      <MobileTabBar
        active="home"
        onHome={() => navigate('/')}
        onSettings={() => navigate('/settings/notifications')}
        onActivity={() => navigate('/activity')}
      />
    </div>
  );
}
