import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { Icon, Tooltip } from '../design-system/primitives';
import { BrandMark } from '../design-system/brand/BrandMark';
import { useWorkspaceUnreadTotals } from '../features/workspaces/useUnreadTotals';
import { CreateWorkspaceDialog } from '../features/workspaces/CreateWorkspaceDialog';
import {
  deriveServerButtonBadge,
  serverButtonBadgeText,
  serverButtonBadgeAria,
} from '../features/workspaces/serverButtonBadge';
import { useBadgeStore } from '../features/notifications/badgeStore';
import { cn } from '../lib/cn';

type Props = {
  workspaces: Array<Pick<Workspace, 'id' | 'name' | 'slug'>>;
  activeSlug: string | null;
};

export function WorkspaceNav({ workspaces, activeSlug }: Props): JSX.Element {
  const { data: totals } = useWorkspaceUnreadTotals();
  // S47 (FR-MN-14): isMuted 제외 서버 진실값 배지(badgeStore)를 우선 사용한다.
  // badgeStore 에 해당 워크스페이스 항목이 있으면(연결 후 1회 재동기화로 채워짐)
  // 그 값(뮤트 채널/서버 제외)을, 없으면 기존 unreadTotals(S22 레일)로 폴백한다.
  const badgeByWs = useBadgeStore((s) => s.byWorkspace);
  const unreadByWs = useMemo(() => {
    const m = new Map<string, { unreadCount: number; mentionCount: number }>();
    for (const t of totals ?? [])
      m.set(t.workspaceId, { unreadCount: t.unreadCount, mentionCount: t.mentionCount });
    for (const [wsId, b] of Object.entries(badgeByWs))
      m.set(wsId, { unreadCount: b.unreadCount, mentionCount: b.mentionCount });
    return m;
  }, [totals, badgeByWs]);

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
        // S22 (FR-RS-15): 멘션 합산>0 → mention 뱃지(숫자=멘션 수), 아니면 기존
        // unread 뱃지. 서버 summarizeWorkspaceTotals 의 mentionCount 를 그대로 사용.
        const badge = deriveServerButtonBadge({
          unreadCount: u?.unreadCount ?? 0,
          mentionCount: u?.mentionCount ?? 0,
        });
        const active = ws.slug === activeSlug;
        const badgeAria = serverButtonBadgeAria(badge);
        // a11y(S22 review #2): `<Link aria-label>` 가 자식 배지의 aria-label 을
        // 가려 스크린리더가 미읽음/멘션 수를 읽지 못한다. Link 의 접근명에
        // 배지 텍스트를 합성하고, 배지 span 은 aria-hidden 으로 둬 중복 통지를
        // 막는다.
        const linkAria = badgeAria ? `${ws.name}, ${badgeAria}` : ws.name;
        return (
          <Tooltip key={ws.id} label={ws.name} side="right">
            <Link
              to={`/w/${ws.slug}`}
              data-testid={`ws-nav-${ws.slug}`}
              aria-label={linkAria}
              // a11y(S22 review #4): `aria-selected` 는 link role 에 비허용 →
              // `aria-current="page"`. DS 활성 셀렉터
              // (`.qf-server-btn[aria-selected="true"]`)가 DS 4파일이라 못
              // 고치므로 활성 배경 + 좌측 pill 을 DS 토큰 arbitrary 로 보강.
              aria-current={active ? 'page' : undefined}
              data-active={active ? 'true' : undefined}
              className={cn(
                'qf-server-btn',
                active &&
                  'rounded-[var(--r-md)] bg-[var(--accent)] text-[var(--text-onAccent)] before:h-[var(--nav-pill-h-active)]',
              )}
              data-unread={badge.variant !== 'none' ? 'true' : 'false'}
              data-mention={badge.variant === 'mention' ? 'true' : 'false'}
            >
              {ws.name.slice(0, 2).toUpperCase()}
              {badge.variant !== 'none' ? (
                <span
                  data-testid={`ws-unread-${ws.slug}`}
                  data-variant={badge.variant}
                  className="qf-server-btn__unread"
                  aria-hidden="true"
                >
                  {serverButtonBadgeText(badge.count)}
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
