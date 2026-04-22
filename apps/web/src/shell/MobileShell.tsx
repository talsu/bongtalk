import { useMemo, useState } from 'react';
import { Navigate, useParams, useNavigate } from 'react-router-dom';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { Icon, ToastViewport } from '../design-system/primitives';
import { FeedbackDialog } from '../features/feedback/FeedbackDialog';
import { MobileChannelList } from './mobile/MobileChannelList';
import { MobileMessages } from './mobile/MobileMessages';
import { MobileMembers } from './mobile/MobileMembers';
import { MobileTabBar } from './mobile/MobileTabBar';
import { MobileDrawer } from './mobile/MobileDrawer';
import { useKeyboardDodge } from '../lib/useKeyboardDodge';
import './mobile/mobile-kb-dodge.css';

/**
 * Task-024 mobile shell — qf-m-screen root, qf-m-topbar header,
 * qf-m-body scrollable middle, qf-m-tabbar footer. Left drawer
 * (☰ → workspaces + channels) + right drawer (👥 → members).
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
  useRealtimeConnection();
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

  if (isLoading) {
    return (
      <div data-testid="mobile-shell-loading" className="qf-m-screen">
        <div className="qf-m-empty">
          <div className="qf-m-empty__body">loading…</div>
        </div>
      </div>
    );
  }
  if ((mine?.workspaces.length ?? 0) === 0) return <Navigate to="/w/new" replace />;
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
  if (!active) return <Navigate to="/w/new" replace />;

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
        onYou={() => navigate('/settings')}
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
