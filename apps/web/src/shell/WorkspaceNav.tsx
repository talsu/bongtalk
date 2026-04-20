import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { Tooltip } from '../design-system/primitives';
import { BrandMark } from '../design-system/brand/BrandMark';
import { cn } from '../lib/cn';

type Props = {
  workspaces: Array<Pick<Workspace, 'id' | 'name' | 'slug'>>;
  activeSlug: string | null;
};

/**
 * 72px leftmost rail. Circular workspace icons + a "new workspace" plus
 * button at the bottom. Every icon has a Tooltip with the workspace name
 * so screen-readers and keyboard users see the same label sighted users
 * read on hover.
 */
export function WorkspaceNav({ workspaces, activeSlug }: Props): JSX.Element {
  return (
    <nav
      aria-label="워크스페이스"
      data-testid="workspace-nav"
      className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-border-subtle bg-bg-subtle py-3"
    >
      {/* Brand symbol at the top of the rail — clicking returns the
          user to the home redirect (first workspace), matching the
          Discord-style "guild list" UX. */}
      <Tooltip label="qufox 홈" side="right">
        <Link
          to="/"
          data-testid="ws-nav-home"
          aria-label="qufox 홈"
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-surface transition-all hover:rounded-md"
        >
          <BrandMark variant="symbol" size={28} decorative />
        </Link>
      </Tooltip>
      <div className="my-1 h-px w-6 bg-border-subtle" aria-hidden />
      {workspaces.map((ws) => {
        const active = ws.slug === activeSlug;
        return (
          <Tooltip key={ws.id} label={ws.name} side="right">
            <Link
              to={`/w/${ws.slug}`}
              data-testid={`ws-nav-${ws.slug}`}
              aria-label={ws.name}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-xl text-sm font-semibold transition-all duration-fast ease-standard',
                active
                  ? 'rounded-md bg-bg-primary text-fg-primary'
                  : 'bg-bg-surface text-foreground hover:rounded-md hover:bg-bg-primary hover:text-fg-primary',
              )}
            >
              {ws.name.slice(0, 2).toUpperCase()}
            </Link>
          </Tooltip>
        );
      })}
      <div className="my-1 h-px w-6 bg-border-subtle" aria-hidden />
      <Tooltip label="새 워크스페이스" side="right">
        <Link
          to="/w/new"
          data-testid="ws-nav-new"
          aria-label="새 워크스페이스 만들기"
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-surface text-lg font-semibold text-success transition-all hover:rounded-md hover:bg-success hover:text-fg-primary"
        >
          +
        </Link>
      </Tooltip>
    </nav>
  );
}
