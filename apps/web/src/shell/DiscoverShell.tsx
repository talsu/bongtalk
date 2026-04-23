import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { WorkspaceNav } from './WorkspaceNav';
import { BottomBar } from './BottomBar';
import { DiscoverPage } from '../features/discovery/DiscoverPage';
import { ToastViewport } from '../design-system/primitives';

/**
 * task-030 follow: the /discover page used to replace the whole viewport,
 * which broke the "server rail is always there" mental model. This shell
 * renders the left WorkspaceNav + BottomBar exactly like the main Shell
 * but swaps the channel/message columns for DiscoverPage. Matches the
 * desktop Discord pattern where the server rail is persistent chrome.
 */
export function DiscoverShell(): JSX.Element {
  const { data: mine, isLoading } = useMyWorkspaces();
  // Keep realtime + prefs warm so navigating back to a workspace doesn't
  // re-subscribe from scratch.
  useRealtimeConnection();
  useNotificationPreferences();

  if (isLoading) {
    return (
      <div data-testid="discover-shell-loading" className="qf-empty h-full">
        <div className="qf-empty__body">loading…</div>
      </div>
    );
  }

  return (
    <div data-testid="discover-shell-root" className="flex h-full bg-background text-foreground">
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <WorkspaceNav workspaces={mine?.workspaces ?? []} activeSlug={null} />
        </div>
        <BottomBar />
      </div>
      <div className="flex-1 min-w-0">
        <DiscoverPage />
      </div>
      <ToastViewport />
    </div>
  );
}
