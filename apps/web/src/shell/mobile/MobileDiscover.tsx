import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WORKSPACE_CATEGORY_META,
  type DiscoveryWorkspace,
  type WorkspaceCategory,
} from '@qufox/shared-types';
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

  // S72 W16 fix-forward (contract/ui-designer): 데스크톱 JoinCta 와 동일한 joinMode 3분기.
  // APPLY 는 join 을 호출하지 않고 곧장 신청 폼으로 보낸다(서버 거부에 의존하지 않음).
  const onApply = (slug: string): void => {
    navigate(`/w/${slug}/apply`);
  };

  // S72 W16 fix-forward (contract/ui-designer): 카드 탭의 동작을 joinMode 로 분기한다.
  // 이전에는 모든 행이 onJoin 을 호출해 APPLY/PRIVATE 가 오동작했다(APPLY 는 서버 409,
  // PRIVATE 는 WORKSPACE_NOT_PUBLIC). PRIVATE 는 비활성(초대 전용)이라 탭해도 동작하지
  // 않는다.
  const onRow = (w: DiscoveryWorkspace): void => {
    if (w.joinMode === 'PRIVATE') return;
    if (w.joinMode === 'APPLY') {
      onApply(w.slug);
      return;
    }
    void onJoin(w.id, w.slug);
  };

  const items = data?.items ?? [];

  return (
    <div data-testid="mobile-discover" className="qf-m-screen qf-m-screen--app">
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

        {/* H-5(071-M0 C4): 9개 카테고리를 균등분할 qf-m-segment 에 넣으면 칩 폭이
            글자 폭 밑으로 떨어져 한 글자씩 세로로 줄바꿈된다 — DS 용도 구분대로
            가로 스크롤 qf-m-filter-bar + qf-m-filter-chip 으로 교체. */}
        <div className="qf-m-filter-bar" data-testid="mobile-discover-segment">
          <button
            type="button"
            className="qf-m-filter-chip"
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
              className="qf-m-filter-chip"
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
          items.map((w) => {
            const isPrivate = w.joinMode === 'PRIVATE';
            const isApply = w.joinMode === 'APPLY';
            // S72 W16 fix-forward: joinMode 별 접근명/탭 동작/아사이드 표시.
            const ariaLabel = isPrivate
              ? `${w.name} — 초대를 받아야 참가할 수 있습니다`
              : isApply
                ? `${w.name}에 가입 신청`
                : `${w.name} 참가`;
            return (
              <button
                key={w.id}
                type="button"
                data-testid={`mobile-discover-row-${w.slug}`}
                aria-label={ariaLabel}
                aria-disabled={isPrivate ? 'true' : undefined}
                onClick={() => onRow(w)}
                className={cn(
                  'w-full text-left qf-m-row',
                  isPrivate && 'text-text-muted cursor-not-allowed',
                )}
              >
                <Avatar name={w.name} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="qf-m-row__primary">{w.name}</div>
                  <div className="qf-m-row__secondary">
                    {WORKSPACE_CATEGORY_META[w.category]?.label ?? w.category} · {w.memberCount}명
                  </div>
                </div>
                <div className="qf-m-row__aside" data-testid={`mobile-discover-cta-${w.slug}`}>
                  {isPrivate ? (
                    <span className="text-[length:var(--fs-12)] text-text-muted">초대 필요</span>
                  ) : isApply ? (
                    <span className="text-[length:var(--fs-12)] text-text-secondary">신청</span>
                  ) : (
                    <Icon name="plus" size="sm" />
                  )}
                </div>
              </button>
            );
          })
        )}
      </main>

      <MobileTabBar />
    </div>
  );
}
