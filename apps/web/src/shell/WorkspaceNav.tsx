import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { Icon, Tooltip } from '../design-system/primitives';
import { BrandMark } from '../design-system/brand/BrandMark';
import { useWorkspaceUnreadTotals } from '../features/workspaces/useUnreadTotals';
import { CreateWorkspaceDialog } from '../features/workspaces/CreateWorkspaceDialog';

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

  // Workspace creation moved from the /w/new page to a DS Dialog that
  // opens in place — no forced-create-on-signup flow means this is the
  // only entry point users regularly see.
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <nav aria-label="워크스페이스" data-testid="workspace-nav" className="qf-serverlist">
      {/* task-033-C + user feedback: single brand-mark button at the top
          of the rail routes to /dm (messages). Previously a separate
          DM icon sat above Home; folded into one so the BrandMark keeps
          its visual place but drives the messages surface. */}
      <Tooltip label="메세지" side="right">
        <Link to="/dm" data-testid="ws-nav-home" aria-label="메세지" className="qf-server-btn">
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
      <Tooltip label="찾기" side="right">
        <Link
          to="/discover"
          data-testid="ws-nav-discover"
          aria-label="공개 워크스페이스 찾기"
          className="qf-server-btn"
        >
          <Icon name="compass" size="md" />
        </Link>
      </Tooltip>
      <Tooltip label="새 워크스페이스" side="right">
        <button
          type="button"
          data-testid="ws-nav-new"
          aria-label="워크스페이스 추가"
          onClick={() => setCreateOpen(true)}
          className="qf-server-btn text-success"
        >
          +
        </button>
      </Tooltip>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </nav>
  );
}
