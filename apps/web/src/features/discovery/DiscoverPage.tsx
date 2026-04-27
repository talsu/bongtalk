import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WORKSPACE_CATEGORY_META, type WorkspaceCategory } from '@qufox/shared-types';
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
    await join.mutateAsync({ workspaceId: id });
    navigate(`/w/${slug}`);
  };

  const items = data?.items ?? [];

  return (
    <div
      data-testid="discover-page"
      className="h-screen flex flex-col"
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
                <Button
                  data-testid={`discover-join-${w.slug}`}
                  onClick={() => onJoin(w.id, w.slug)}
                  size="sm"
                >
                  참가
                </Button>
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
