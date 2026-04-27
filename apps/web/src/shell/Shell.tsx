import { useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { WorkspaceNav } from './WorkspaceNav';
import { ChannelColumn } from './ChannelColumn';
import { MessageColumn } from './MessageColumn';
import { MemberColumn } from './MemberColumn';
import { BottomBar } from './BottomBar';
import { ChannelSettingsPage } from '../features/channels/ChannelSettingsPage';
import { WorkspaceSettingsPage } from '../features/workspaces/WorkspaceSettingsPage';
import { useMembers } from '../features/workspaces/useWorkspaces';
import { useAuth } from '../features/auth/AuthProvider';
import { ToastViewport } from '../design-system/primitives';
import { CommandPalette } from '../features/shortcuts/CommandPalette';
import { ShortcutHelp } from '../features/shortcuts/ShortcutHelp';
import { FeedbackDialog } from '../features/feedback/FeedbackDialog';
import { useGlobalShortcuts } from '../features/shortcuts/useShortcut';
import { useIsMobile } from '../lib/useBreakpoint';
import { MobileShell } from './MobileShell';

/**
 * Top-level Discord-style 3-column layout (4 counting the leftmost rail).
 * Renders the same React tree for every URL under /w/* — only the leaf
 * columns read the URL params, so switching channels does not remount the
 * shell.
 */
export function Shell(): JSX.Element {
  const isMobile = useIsMobile();
  // Task-024: branch on viewport at mount time. Crossing the 768px
  // breakpoint remounts via React's key-based reconciliation below —
  // live reflow across layouts isn't required and creates subtle
  // drag-state / scroll-state leaks.
  if (isMobile) return <MobileShell key="mobile" />;
  return <DesktopShell key="desktop" />;
}

function DesktopShell(): JSX.Element {
  // With the splat route `/w/:slug/*`, React Router delivers the
  // remainder under the `'*'` key. Parsing here keeps `channelName`
  // behaviour identical to the old discrete-param version without
  // remounting the Shell on a URL change.
  const params = useParams<{ slug: string; '*'?: string }>();
  const slug = params.slug;
  const rest = (params['*'] ?? '').split('/').filter(Boolean);
  // task-031-A: /w/:slug/settings opens the workspace-level settings
  // overlay. rest[0] === 'settings' (no channel segment).
  const inWorkspaceSettings = rest[0] === 'settings' && !rest[1];
  const channelName = inWorkspaceSettings ? undefined : rest[0];
  // URL shape: /w/:slug/:channel[/settings[/:section]]. Anything in rest[1]
  // named "settings" switches the middle column from MessageColumn to
  // ChannelSettingsPage while keeping the left rail + channel list intact.
  const inChannelSettings = rest[1] === 'settings';
  const settingsSection: 'general' = 'general';
  const { data: mine, isLoading } = useMyWorkspaces();
  // task-040 R3 + reviewer H1: realtime is now installed once at App
  // root via AppRealtimeHost so the ConnectionBanner survives every
  // shell early-return path. Shell only needs the side-effects of
  // the dispatcher being installed — the singleton in socket.ts is
  // already running.
  useGlobalShortcuts();
  // task-019-D: warm the notification-preferences cache so the
  // dispatcher's synchronous resolver hits immediately instead of
  // falling back to defaults for the first volley of events.
  useNotificationPreferences();

  const active = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: channels } = useChannelList(active?.id);

  const activeChannel = useMemo(() => {
    if (!channels || !channelName) return null;
    const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
    return flat.find((c) => c.name === channelName) ?? null;
  }, [channels, channelName]);

  if (isLoading) {
    return (
      <div data-testid="shell-loading" className="qf-empty h-full">
        <div className="qf-empty__body">loading…</div>
      </div>
    );
  }

  // No workspaces yet → land on /dm (messages). DM + discover are both
  // accessible to a zero-workspace account, so we no longer force the
  // user into the create-workspace page on signup. They can create one
  // voluntarily via the "+" button on the server rail.
  if ((mine?.workspaces.length ?? 0) === 0) {
    return <Navigate to="/dm" replace />;
  }

  // Workspace id in URL but doesn't exist for me → go home.
  if (slug && !active) {
    return (
      <div data-testid="shell-ws-not-found" className="qf-empty h-full">
        <div className="qf-empty__title">워크스페이스를 찾을 수 없습니다</div>
      </div>
    );
  }

  // If no slug at all, redirect to the first workspace the user is in.
  if (!slug && mine) {
    return <Navigate to={`/w/${mine.workspaces[0].slug}`} replace />;
  }

  return (
    <div data-testid="shell-root" className="flex h-full bg-background text-foreground">
      {/* Left stack: server rail + channel list share the full height with
          a bottom-bar pinned under them. Main chat + member list below
          live in their own columns and run floor-to-ceiling. */}
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <WorkspaceNav workspaces={mine?.workspaces ?? []} activeSlug={slug ?? null} />
          {active ? (
            <ChannelColumn workspace={active} activeChannelName={activeChannel?.name ?? null} />
          ) : null}
        </div>
        <BottomBar />
      </div>
      {active && activeChannel ? (
        <MessageColumn
          workspaceId={active.id}
          workspaceSlug={active.slug}
          channelId={activeChannel.id}
          channelName={activeChannel.name}
          channelTopic={activeChannel.topic ?? null}
        />
      ) : (
        <main className="qf-empty flex-1">
          <div className="qf-empty__title">
            {active ? '채널을 선택하세요.' : '워크스페이스를 선택하세요.'}
          </div>
          <div className="qf-empty__body">
            좌측 사이드바에서 {active ? '채널' : '워크스페이스'}을(를) 선택해 대화를 시작하세요.
          </div>
        </main>
      )}
      {active && activeChannel ? <MemberColumn workspaceId={active.id} /> : null}
      {/* Settings screens are full-viewport overlays — they sit on top
          of the shell via a portal. Reusing SettingsOverlay for every
          future settings surface (workspace, account, …) keeps the
          chrome consistent. */}
      {active && activeChannel && inChannelSettings ? (
        <ChannelSettingsPage
          workspaceId={active.id}
          workspaceSlug={active.slug}
          channel={activeChannel}
          section={settingsSection}
        />
      ) : null}
      {active && inWorkspaceSettings ? (
        <WorkspaceSettingsOverlayHost workspace={active} workspaceSlug={active.slug} />
      ) : null}
      <CommandPalette />
      <ShortcutHelp />
      <FeedbackDialog />
      <ToastViewport />
    </div>
  );
}

function WorkspaceSettingsOverlayHost({
  workspace,
  workspaceSlug,
}: {
  workspace: {
    id: string;
    name: string;
    description: string | null;
    visibility: 'PUBLIC' | 'PRIVATE';
    category: string | null;
  };
  workspaceSlug: string;
}): JSX.Element | null {
  const { user } = useAuth();
  const { data: members } = useMembers(workspace.id);
  const myRole = (members?.members.find((m) => m.userId === user?.id)?.role ?? 'MEMBER') as
    | 'OWNER'
    | 'ADMIN'
    | 'MEMBER';
  return (
    <WorkspaceSettingsPage
      workspace={{
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        visibility: workspace.visibility,
        category: workspace.category as never,
      }}
      myRole={myRole}
      workspaceSlug={workspaceSlug}
    />
  );
}
