import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { Tooltip } from '../design-system/primitives';
import { BrandMark } from '../design-system/brand/BrandMark';

type Props = {
  workspaces: Array<Pick<Workspace, 'id' | 'name' | 'slug'>>;
  activeSlug: string | null;
};

export function WorkspaceNav({ workspaces, activeSlug }: Props): JSX.Element {
  return (
    <nav aria-label="워크스페이스" data-testid="workspace-nav" className="qf-serverlist">
      <Tooltip label="qufox 홈" side="right">
        <Link to="/" data-testid="ws-nav-home" aria-label="qufox 홈" className="qf-server-btn">
          <BrandMark variant="symbol" size={28} decorative />
        </Link>
      </Tooltip>
      <div aria-hidden className="h-px w-6 bg-border" />
      {workspaces.map((ws) => (
        <Tooltip key={ws.id} label={ws.name} side="right">
          <Link
            to={`/w/${ws.slug}`}
            data-testid={`ws-nav-${ws.slug}`}
            aria-label={ws.name}
            aria-selected={ws.slug === activeSlug}
            aria-current={ws.slug === activeSlug ? 'true' : undefined}
            className="qf-server-btn"
          >
            {ws.name.slice(0, 2).toUpperCase()}
          </Link>
        </Tooltip>
      ))}
      <div aria-hidden className="h-px w-6 bg-border" />
      <Tooltip label="새 워크스페이스" side="right">
        <Link
          to="/w/new"
          data-testid="ws-nav-new"
          aria-label="새 워크스페이스 만들기"
          className="qf-server-btn text-success"
        >
          +
        </Link>
      </Tooltip>
    </nav>
  );
}
