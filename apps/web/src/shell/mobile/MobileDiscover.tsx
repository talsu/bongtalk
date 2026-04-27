import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WORKSPACE_CATEGORY_META, type WorkspaceCategory } from '@qufox/shared-types';
import { Avatar, Icon } from '../../design-system/primitives';
import { useDiscoverWorkspaces, useJoinWorkspace } from '../../features/discovery/useDiscovery';
import { MobileTabBar } from './MobileTabBar';
import { cn } from '../../lib/cn';

/**
 * task-030-F: mobile /discover — qf-m-screen + qf-m-topbar +
 * qf-m-segment (category tabs) + qf-m-search + qf-m-row per workspace.
 */
export function MobileDiscover(): JSX.Element {
  const navigate = useNavigate();
  const [category, setCategory] = useState<WorkspaceCategory | ''>('');
  const [q, setQ] = useState('');
  const { data, isLoading } = useDiscoverWorkspaces({ category, q });
  const join = useJoinWorkspace();

  const onJoin = async (id: string, slug: string): Promise<void> => {
    await join.mutateAsync({ workspaceId: id });
    navigate(`/w/${slug}`);
  };

  const items = data?.items ?? [];

  return (
    <div data-testid="mobile-discover" className="qf-m-screen">
      <header className="qf-m-topbar qf-m-safe-top">
        <button
          type="button"
          aria-label="뒤로"
          className="qf-m-topbar__back"
          onClick={() => navigate(-1)}
          data-testid="mobile-discover-back"
        >
          <Icon name="chevron-left" size="md" />
        </button>
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">찾기</div>
          <div className="qf-m-topbar__subtitle">공개 워크스페이스</div>
        </div>
        <div />
      </header>

      <main className="qf-m-body">
        <div className="px-[var(--s-4)] pt-[var(--s-2)]">
          <div className="qf-m-search" data-testid="mobile-discover-search">
            <Icon name="search" size="sm" />
            <input
              type="search"
              className="qf-m-search__input"
              aria-label="워크스페이스 검색"
              placeholder="이름으로 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="mobile-discover-search-input"
            />
          </div>
        </div>

        <div
          className="qf-m-segment"
          data-testid="mobile-discover-segment"
          style={{ overflowX: 'auto' }}
        >
          <button
            type="button"
            className="qf-m-segment__btn"
            aria-selected={category === ''}
            data-testid="mobile-discover-cat-all"
            onClick={() => setCategory('')}
          >
            전체
          </button>
          {(Object.keys(WORKSPACE_CATEGORY_META) as WorkspaceCategory[]).map((c) => (
            <button
              key={c}
              type="button"
              className="qf-m-segment__btn"
              aria-selected={category === c}
              data-testid={`mobile-discover-cat-${c}`}
              onClick={() => setCategory(c)}
            >
              {WORKSPACE_CATEGORY_META[c].label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : items.length === 0 ? (
          <div className="qf-m-empty" data-testid="mobile-discover-empty">
            <div className="qf-m-empty__title">공개 워크스페이스가 없습니다</div>
            <div className="qf-m-empty__body">다른 카테고리/검색어를 시도하세요.</div>
          </div>
        ) : (
          items.map((w) => (
            <button
              key={w.id}
              type="button"
              data-testid={`mobile-discover-row-${w.slug}`}
              onClick={() => onJoin(w.id, w.slug)}
              className={cn('w-full text-left qf-m-row')}
            >
              <Avatar name={w.name} size="md" />
              <div className="min-w-0 flex-1">
                <div className="qf-m-row__primary">{w.name}</div>
                <div className="qf-m-row__secondary">
                  {WORKSPACE_CATEGORY_META[w.category]?.label ?? w.category} · {w.memberCount}명
                </div>
              </div>
              <div className="qf-m-row__aside">
                <Icon name="plus" size="sm" />
              </div>
            </button>
          ))
        )}
      </main>

      <MobileTabBar
        onHome={() => navigate('/')}
        onSettings={() => navigate('/settings/notifications')}
        onActivity={() => navigate('/activity')}
      />
    </div>
  );
}
