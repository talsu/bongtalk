import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { Tooltip } from '../design-system/primitives';
import { BrandMark } from '../design-system/brand/BrandMark';
import { useWorkspaceUnreadTotals } from '../features/workspaces/useUnreadTotals';

type Props = {
  workspaces: Array<Pick<Workspace, 'id' | 'name' | 'slug'>>;
  activeSlug: string | null;
};

export function WorkspaceNav({ workspaces, activeSlug }: Props): JSX.Element {
  const { data: totals } = useWorkspaceUnreadTotals();
  const unreadByWs = useMemo(() => {
    const m = new Map<string, { count: number; mention: boolean }>();
    for (const t of totals ?? [])
      m.set(t.workspaceId, { count: t.unreadCount, mention: t.hasMention });
    return m;
  }, [totals]);

  return (
    <nav aria-label="워크스페이스" data-testid="workspace-nav" className="qf-serverlist">
      <Tooltip label="qufox 홈" side="right">
        <Link to="/" data-testid="ws-nav-home" aria-label="qufox 홈" className="qf-server-btn">
          <BrandMark variant="symbol" size={28} decorative />
        </Link>
      </Tooltip>
      <div aria-hidden className="h-px w-6 bg-border" />
      {workspaces.map((ws) => {
        const u = unreadByWs.get(ws.id);
        const count = u?.count ?? 0;
        return (
          <Tooltip key={ws.id} label={ws.name} side="right">
            <Link
              to={`/w/${ws.slug}`}
              data-testid={`ws-nav-${ws.slug}`}
              aria-label={ws.name}
              aria-selected={ws.slug === activeSlug}
              aria-current={ws.slug === activeSlug ? 'true' : undefined}
              className="qf-server-btn"
              data-unread={count > 0 ? 'true' : 'false'}
              data-mention={u?.mention ? 'true' : 'false'}
            >
              {ws.name.slice(0, 2).toUpperCase()}
              {count > 0 ? (
                <span
                  data-testid={`ws-unread-${ws.slug}`}
                  className="qf-server-btn__unread"
                  aria-label={u?.mention ? `읽지 않은 멘션 ${count}개` : `읽지 않음 ${count}개`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              ) : null}
            </Link>
          </Tooltip>
        );
      })}
      <div aria-hidden className="h-px w-6 bg-border" />
      <Tooltip label="새 워크스페이스" side="right">
        <Link
          to="/w/new"
          data-testid="ws-nav-new"
          aria-label="워크스페이스 추가"
          className="qf-server-btn text-success"
        >
          +
        </Link>
      </Tooltip>
    </nav>
  );
}
