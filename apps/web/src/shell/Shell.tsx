import { useMemo } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { WorkspaceNav } from './WorkspaceNav';
import { ChannelColumn } from './ChannelColumn';
import { MessageColumn } from './MessageColumn';
import { MemberColumn } from './MemberColumn';
import { BottomBar } from './BottomBar';
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
  const { data: mine, isLoading } = useMyWorkspaces();
  useRealtimeConnection();
  useGlobalShortcuts();

  const active = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: channels } = useChannelList(active?.id);

  const activeChannel = useMemo(() => {
    if (!channels || !channelName) return null;
    const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
    return flat.find((c) => c.name === channelName) ?? null;
  }, [channels, channelName]);

  if (isLoading) {
    return (
      <div
        data-testid="shell-loading"
        className="grid h-full place-items-center text-sm text-text-muted"
      >
        loading…
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
      <div data-testid="shell-ws-not-found" className="grid h-full place-items-center text-sm">
        workspace not found
      </div>
    );
  }

  // If no slug at all, redirect to the first workspace the user is in.
  if (!slug && mine) {
    return <Navigate to={`/w/${mine.workspaces[0].slug}`} replace />;
  }

  return (
    <div data-testid="shell-root" className="flex h-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <WorkspaceNav workspaces={mine?.workspaces ?? []} activeSlug={slug ?? null} />
        {active ? (
          <ChannelColumn workspace={active} activeChannelName={activeChannel?.name ?? null} />
        ) : null}
        {active && activeChannel ? (
          <MessageColumn
            workspaceId={active.id}
            workspaceSlug={active.slug}
            channelId={activeChannel.id}
            channelName={activeChannel.name}
          />
        ) : (
          <main className="flex-1 grid place-items-center text-sm text-text-muted">
            {active ? '채널을 선택하세요.' : '워크스페이스를 선택하세요.'}
          </main>
        )}
        {active && activeChannel ? <MemberColumn workspaceId={active.id} /> : null}
      </div>
      <BottomBar />
      <CommandPalette />
      <ShortcutHelp />
      <SearchOverlay />
      <FeedbackDialog />
      <ToastViewport />
    </div>
  );
}
