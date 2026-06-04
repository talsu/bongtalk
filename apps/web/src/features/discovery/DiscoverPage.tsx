import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WORKSPACE_CATEGORY_META,
  type DiscoveryWorkspace,
  type WorkspaceCategory,
} from '@qufox/shared-types';
import { Icon, Avatar, Button } from '../../design-system/primitives';
import { useDiscoverWorkspaces, useJoinWorkspace } from './useDiscovery';
import { cn } from '../../lib/cn';

/**
 * task-030-E: desktop /discover — category chip row + search + card grid.
 * Join CTA calls POST /workspaces/:id/join and then routes into the joined
 * workspace.
 */
export function DiscoverPage(): JSX.Element {
  const [category, setCategory] = useState<WorkspaceCategory | ''>('');
  const [q, setQ] = useState('');
  const { data, isLoading } = useDiscoverWorkspaces({ category, q });
  const join = useJoinWorkspace();
  const navigate = useNavigate();

  const onJoin = async (id: string, slug: string): Promise<void> => {
    try {
      await join.mutateAsync({ workspaceId: id });
      navigate(`/w/${slug}`);
    } catch (err) {
      // S70 (FR-W06): APPLY 모드 워크스페이스는 즉시 가입이 거부된다. 가입 신청 폼으로 유도한다.
      const code = (err as (Error & { errorCode?: string }) | undefined)?.errorCode;
      if (code === 'WORKSPACE_APPLY_NOT_SUPPORTED' || code === 'APPLICATION_NOT_APPLICABLE') {
        navigate(`/w/${slug}/apply`);
        return;
      }
      throw err;
    }
  };

  // S72 (D13 / FR-W16): joinMode 에 따라 카드 CTA 를 분기한다. APPLY 는 join 을
  // 호출하지 않고 곧장 신청 폼으로 보낸다(서버 거부에 의존하지 않음 — 더 빠른 UX).
  const onApply = (slug: string): void => {
    navigate(`/w/${slug}/apply`);
  };

  const items = data?.items ?? [];

  return (
    <div
      data-testid="discover-page"
      className="h-full flex flex-col"
      style={{ background: 'var(--bg-app)' }}
    >
      <header className="flex items-center gap-[var(--s-3)] px-[var(--s-6)] h-[var(--h-topbar)] border-b border-border-subtle">
        <Icon name="compass" size="md" />
        <div className="font-semibold text-[length:var(--fs-16)]">찾기</div>
        <div className="ml-auto">
          <input
            type="search"
            placeholder="워크스페이스 검색"
            aria-label="워크스페이스 검색"
            data-testid="discover-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="qf-input"
          />
        </div>
      </header>

      <nav
        aria-label="카테고리"
        data-testid="discover-categories"
        className="flex gap-[var(--s-2)] overflow-x-auto px-[var(--s-6)] py-[var(--s-3)] border-b border-border-subtle"
      >
        <CategoryChip
          id=""
          label="전체"
          icon="compass"
          selected={category === ''}
          onClick={() => setCategory('')}
        />
        {(Object.keys(WORKSPACE_CATEGORY_META) as WorkspaceCategory[]).map((c) => (
          <CategoryChip
            key={c}
            id={c}
            label={WORKSPACE_CATEGORY_META[c].label}
            icon={WORKSPACE_CATEGORY_META[c].icon}
            selected={category === c}
            onClick={() => setCategory(c)}
          />
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-[var(--s-6)]" data-testid="discover-grid">
        {isLoading ? (
          <div className="text-text-muted">불러오는 중…</div>
        ) : items.length === 0 ? (
          <div className="qf-empty p-[var(--s-6)]">
            <div className="font-semibold">조건에 맞는 공개 워크스페이스가 없습니다</div>
            <div className="text-text-muted mt-[var(--s-2)]">
              다른 카테고리 또는 검색어를 시도하세요.
            </div>
          </div>
        ) : (
          <div
            className="grid gap-[var(--s-4)]"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {items.map((w) => (
              <article
                key={w.id}
                data-testid={`discover-card-${w.slug}`}
                className="rounded-[var(--r-lg)] border border-border-subtle p-[var(--s-4)] flex flex-col gap-[var(--s-3)]"
                style={{ background: 'var(--bg-elevated)' }}
              >
                <div className="flex items-center gap-[var(--s-3)]">
                  <Avatar name={w.name} size="md" />
                  <div className="min-w-0">
                    <div className="font-semibold text-[length:var(--fs-14)] truncate">
                      {w.name}
                    </div>
                    <div className="text-[length:var(--fs-12)] text-text-muted">
                      {WORKSPACE_CATEGORY_META[w.category]?.label ?? w.category} · {w.memberCount}명
                    </div>
                  </div>
                </div>
                {w.description ? (
                  <p className="text-[length:var(--fs-13)] text-text-secondary line-clamp-3">
                    {w.description}
                  </p>
                ) : null}
                <JoinCta workspace={w} onJoin={onJoin} onApply={onApply} />
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function CategoryChip({
  id,
  label,
  icon,
  selected,
  onClick,
}: {
  id: string;
  label: string;
  icon: string;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`discover-cat-${id || 'all'}`}
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'flex items-center gap-[var(--s-2)] px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-pill)] border border-border-subtle whitespace-nowrap',
        selected ? 'bg-bg-accent text-text-strong' : 'bg-bg-subtle text-text-muted',
      )}
    >
      <Icon name={icon as never} size="sm" />
      <span className="text-[length:var(--fs-13)]">{label}</span>
    </button>
  );
}

/**
 * S72 (D13 / FR-W16): 디스커버리 카드 CTA — joinMode 3분기.
 *   PUBLIC  → "참가"      → onJoin(즉시 가입 후 워크스페이스 진입).
 *   APPLY   → "신청"      → onApply(가입 신청 폼 /w/:slug/apply).
 *   PRIVATE → "초대 필요"  → 비활성(초대로만 진입 가능).
 */
function JoinCta({
  workspace: w,
  onJoin,
  onApply,
}: {
  workspace: DiscoveryWorkspace;
  onJoin: (id: string, slug: string) => void;
  onApply: (slug: string) => void;
}): JSX.Element {
  if (w.joinMode === 'APPLY') {
    return (
      <Button
        data-testid={`discover-cta-${w.slug}`}
        variant="secondary"
        onClick={() => onApply(w.slug)}
        size="sm"
      >
        신청
      </Button>
    );
  }
  if (w.joinMode === 'PRIVATE') {
    return (
      <Button
        data-testid={`discover-cta-${w.slug}`}
        variant="ghost"
        size="sm"
        disabled
        aria-disabled="true"
        aria-label="초대를 받아야 참가할 수 있습니다"
      >
        초대 필요
      </Button>
    );
  }
  // PUBLIC(기본)
  return (
    <Button data-testid={`discover-cta-${w.slug}`} onClick={() => onJoin(w.id, w.slug)} size="sm">
      참가
    </Button>
  );
}
