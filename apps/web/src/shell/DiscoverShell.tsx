import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useRealtimeConnection } from '../features/realtime/useRealtimeConnection';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { WorkspaceNav } from './WorkspaceNav';
import { BottomBar } from './BottomBar';
import { DiscoverPage } from '../features/discovery/DiscoverPage';
import { Icon, ToastViewport } from '../design-system/primitives';

/**
 * task-030 follow: the /discover page used to replace the whole viewport,
 * which broke the "server rail is always there" mental model. This shell
 * renders the left WorkspaceNav + BottomBar exactly like the main Shell
 * but swaps the channel/message columns for DiscoverPage. Matches the
 * desktop Discord pattern where the server rail is persistent chrome.
 *
 * User feedback (2026-04-23): the rail sat directly next to the discover
 * page with no channel list in between, so the BottomBar — sized to
 * rail+channellist in the Shell/DmShell layouts — looked off. Layout
 * now mirrors the three-column pattern: [rail | aside | main]. The aside
 * currently holds a single "워크스페이스 찾기" row; future discover
 * categories (people / channels / etc.) slot in here without touching
 * the surrounding chrome.
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
          <aside
            className="qf-channellist flex flex-col"
            style={{ width: 'var(--w-channellist)', background: 'var(--bg-panel)' }}
            data-testid="discover-side"
          >
            <header className="qf-topbar">
              <h2 className="qf-topbar__title">찾기</h2>
            </header>
            <nav className="flex-1 overflow-y-auto" aria-label="찾기 카테고리">
              <div
                data-testid="discover-side-workspaces"
                aria-current="page"
                className="qf-channel qf-channel--active"
              >
                <Icon name="compass" size="sm" className="text-text-muted" />
                <span className="flex-1">워크스페이스 찾기</span>
              </div>
            </nav>
          </aside>
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
