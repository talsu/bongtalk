import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { Icon, ToastViewport } from '../design-system/primitives';
import { FeedbackDialog } from '../features/feedback/FeedbackDialog';
import { MobileChannelList } from './mobile/MobileChannelList';
import { MobileHome } from './mobile/MobileHome';
import { MobileMessages } from './mobile/MobileMessages';
import { MobileMembers } from './mobile/MobileMembers';
import { MobileTabBar } from './mobile/MobileTabBar';
import { MobileDrawer } from './mobile/MobileDrawer';
import { useKeyboardDodge } from '../lib/useKeyboardDodge';
import './mobile/mobile-kb-dodge.css';
import './mobile/mobile-touch-target.css';

/**
 * Task-024 mobile shell — qf-m-screen root, qf-m-topbar header,
 * qf-m-body scrollable middle, qf-m-tabbar footer. Left drawer
 * (menu → workspaces + channels) + right drawer (users → members).
 * Desktop shell stays unchanged; Shell.tsx branches on a 768px
 * media-query via useIsMobile.
 *
 * Non-goals per task-024 scope: voice rooms, rich-text toolbar,
 * custom emoji, mobile-specific push notification settings (all
 * exist on desktop, reachable from the You tab's redirect on click).
 */
export function MobileShell(): JSX.Element {
  const params = useParams<{ slug: string; '*'?: string }>();
  const slug = params.slug;
  const rest = (params['*'] ?? '').split('/').filter(Boolean);
  const channelName = rest[0] ?? undefined;
  const { data: mine, isLoading } = useMyWorkspaces();
  // task-040 R3 + reviewer H1: realtime now App-level (see App.tsx
  // AppRealtimeHost). Banner survives mobile early-returns.
  useNotificationPreferences();
  // visualViewport-driven keyboard dodge — shrinks qf-m-body when the
  // software keyboard opens so the composer doesn't get covered.
  useKeyboardDodge();

  const active = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: channels } = useChannelList(active?.id);
  const activeChannel = useMemo(() => {
    if (!channels || !channelName) return null;
    const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
    return flat.find((c) => c.name === channelName) ?? null;
  }, [channels, channelName]);

  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Close both drawers on route change — covers hardware back, channel
  // picks that navigate, and tab taps. Matches user intent: the drawer
  // is a per-screen modal, not a persistent surface.
  useEffect(() => {
    setLeftOpen(false);
    setRightOpen(false);
  }, [location.pathname]);

  if (isLoading) {
    return (
      <div data-testid="mobile-shell-loading" className="qf-m-screen">
        <div className="qf-m-empty">
          <div className="qf-m-empty__body">loading…</div>
        </div>
      </div>
    );
  }
  // No workspaces yet → land on /dm instead of forcing workspace
  // creation; DM + discover are both available to a zero-workspace
  // account. (Desktop Shell.tsx has the same redirect.)
  if ((mine?.workspaces.length ?? 0) === 0) return <Navigate to="/dm" replace />;
  // task-035-E: mobile base state (/, no slug) renders MobileHome with
  // its own rail/content split. Specific workspace routes (/w/:slug/*)
  // continue to use the drawer-based MobileShell so channel-deep
  // navigation stays identical to 024's behaviour.
  if (!slug) {
    return <MobileHome />;
  }
  if (slug && !active) {
    return (
      <div data-testid="mobile-shell-ws-not-found" className="qf-m-screen">
        <header className="qf-m-topbar">
          <div className="qf-m-topbar__titleBlock">
            <div className="qf-m-topbar__title">워크스페이스를 찾을 수 없습니다</div>
          </div>
        </header>
      </div>
    );
  }
  if (!slug && mine) {
    return <Navigate to={`/w/${mine.workspaces[0].slug}`} replace />;
  }
  if (!active) return <Navigate to="/dm" replace />;

  const topbarTitle = activeChannel ? `# ${activeChannel.name}` : active.name;
  const topbarSubtitle = activeChannel ? active.name : '채널을 선택하세요';

  return (
    <div data-testid="mobile-shell" className="qf-m-screen">
      <header className="qf-m-topbar qf-m-safe-top">
        <button
          type="button"
          data-testid="mobile-topbar-menu"
          className="qf-m-topbar__back"
          aria-label="메뉴 열기"
          onClick={() => setLeftOpen(true)}
        >
          <Icon name="grid" size="md" />
        </button>
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">{topbarTitle}</div>
          <div className="qf-m-topbar__subtitle">{topbarSubtitle}</div>
        </div>
        <div className="qf-m-topbar__actions">
          {activeChannel ? (
            <button
              type="button"
              data-testid="mobile-topbar-members"
              className="qf-m-topbar__action"
              aria-label="멤버 보기"
              onClick={() => setRightOpen(true)}
            >
              <Icon name="users" size="md" />
            </button>
          ) : null}
        </div>
      </header>

      <main className="qf-m-body">
        {activeChannel ? (
          <MobileMessages
            workspaceId={active.id}
            workspaceSlug={active.slug}
            channelId={activeChannel.id}
            channelName={activeChannel.name}
          />
        ) : (
          <div className="qf-m-empty">
            <div className="qf-m-empty__title">채널을 선택하세요</div>
            <div className="qf-m-empty__body">좌상단 메뉴에서 채널을 고르면 대화가 시작돼요.</div>
          </div>
        )}
      </main>

      <MobileTabBar
        onHome={() => navigate(`/w/${active.slug}`)}
        onSettings={() => navigate('/settings')}
        onActivity={() => navigate('/activity')}
      />

      {/* Left drawer: workspace + channel list */}
      <MobileDrawer
        side="left"
        open={leftOpen}
        onClose={() => setLeftOpen(false)}
        testId="mobile-left-drawer"
      >
        <MobileChannelList
          workspace={active}
          workspaces={mine?.workspaces ?? []}
          activeChannelName={activeChannel?.name ?? null}
          onPick={() => setLeftOpen(false)}
        />
      </MobileDrawer>

      {/* Right drawer: member list for active channel */}
      <MobileDrawer
        side="right"
        open={rightOpen}
        onClose={() => setRightOpen(false)}
        testId="mobile-right-drawer"
      >
        <MobileMembers workspaceId={active.id} />
      </MobileDrawer>

      <FeedbackDialog />
      <ToastViewport />
    </div>
  );
}
