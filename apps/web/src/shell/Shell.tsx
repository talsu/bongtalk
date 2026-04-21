import { useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { WorkspaceNav } from './WorkspaceNav';
import { ChannelColumn } from './ChannelColumn';
import { MessageColumn } from './MessageColumn';
import { MemberColumn } from './MemberColumn';
import { BottomBar } from './BottomBar';
import { ChannelSettingsPage } from '../features/channels/ChannelSettingsPage';
import { ToastViewport } from '../design-system/primitives';
import { CommandPalette } from '../features/shortcuts/CommandPalette';
import { ShortcutHelp } from '../features/shortcuts/ShortcutHelp';
import { SearchOverlay } from '../features/search/SearchOverlay';
import { FeedbackDialog } from '../features/feedback/FeedbackDialog';
import { useGlobalShortcuts } from '../features/shortcuts/useShortcut';

/**
 * Top-level Discord-style 3-column layout (4 counting the leftmost rail).
 * Renders the same React tree for every URL under /w/* — only the leaf
 * columns read the URL params, so switching channels does not remount the
 * shell.
 */
export function Shell(): JSX.Element {
  // With the splat route `/w/:slug/*`, React Router delivers the
  // remainder under the `'*'` key. Parsing here keeps `channelName`
  // behaviour identical to the old discrete-param version without
  // remounting the Shell on a URL change.
  const params = useParams<{ slug: string; '*'?: string }>();
  const slug = params.slug;
  const rest = (params['*'] ?? '').split('/').filter(Boolean);
  const channelName = rest[0] ?? undefined;
  // URL shape: /w/:slug/:channel[/settings[/:section]]. Anything in rest[1]
  // named "settings" switches the middle column from MessageColumn to
  // ChannelSettingsPage while keeping the left rail + channel list intact.
  const inChannelSettings = rest[1] === 'settings';
  const settingsSection: 'general' = 'general';
  const { data: mine, isLoading } = useMyWorkspaces();
  useRealtimeConnection();
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

  // No workspaces yet → land on create page.
  if ((mine?.workspaces.length ?? 0) === 0) {
    return <Navigate to="/w/new" replace />;
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
      {active && activeChannel && inChannelSettings ? (
        <div className="flex min-w-0 flex-1">
          <ChannelSettingsPage
            workspaceId={active.id}
            workspaceSlug={active.slug}
            channel={activeChannel}
            section={settingsSection}
          />
        </div>
      ) : active && activeChannel ? (
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
      {active && activeChannel && !inChannelSettings ? (
        <MemberColumn workspaceId={active.id} />
      ) : null}
      <CommandPalette />
      <ShortcutHelp />
      <SearchOverlay />
      <FeedbackDialog />
      <ToastViewport />
    </div>
  );
}
