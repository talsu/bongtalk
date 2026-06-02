import { useState } from 'react';
import type { SaveStatus } from '@qufox/shared-types';
import { SavedItem } from './SavedItem';
import { useSavedCount, useSavedList, useToggleSave } from './useSavedMessages';

// S51 (D10 / FR-PS-07): 개인 저장함 3탭 뷰. Slack Later 3탭(진행 중 / 보관 / 완료)에
// 1:1 대응한다. S51 은 IN_PROGRESS 만 채워지며(탭 간 이동/완료 표시는 S52/FR-PS-08
// carryover), ARCHIVED/COMPLETED 탭은 현재 빈 상태로 표시된다.
const TABS: { id: SaveStatus; label: string }[] = [
  { id: 'IN_PROGRESS', label: '진행 중' },
  { id: 'ARCHIVED', label: '보관' },
  { id: 'COMPLETED', label: '완료' },
];

export function SavedView(): JSX.Element {
  const [active, setActive] = useState<SaveStatus>('IN_PROGRESS');
  const list = useSavedList(active);
  const count = useSavedCount();
  const toggle = useToggleSave();

  const items = list.data?.items ?? [];

  return (
    <section data-testid="saved-view" className="flex flex-col h-full">
      <header className="px-[var(--s-5)] pt-[var(--s-5)]">
        <h1
          className="m-0"
          style={{ font: '700 var(--fs-20) var(--font-sans)', color: 'var(--text-strong)' }}
        >
          저장됨
        </h1>
        <div className="qf-tabs mt-[var(--s-4)]" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`saved-tab-${t.id}`}
              aria-selected={t.id === active}
              data-testid={`saved-tab-${t.id}`}
              onClick={() => setActive(t.id)}
              className="qf-tabs__item"
            >
              {t.label}
              {t.id === 'IN_PROGRESS' && count.data && count.data.count > 0 ? (
                <span className="qf-badge qf-badge--accent ml-[var(--s-2)]">
                  {count.data.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>

      <div
        role="tabpanel"
        aria-labelledby={`saved-tab-${active}`}
        data-testid={`saved-panel-${active}`}
        className="flex-1 overflow-y-auto px-[var(--s-5)] pb-[var(--s-5)]"
      >
        {list.isLoading ? (
          <p className="text-text-muted py-[var(--s-5)]">불러오는 중…</p>
        ) : items.length === 0 ? (
          <div className="qf-empty">
            <div className="qf-empty__title">저장한 메시지가 없습니다</div>
            <p className="qf-empty__body">
              메시지에 마우스를 올린 뒤 북마크 아이콘을 눌러 나중에 읽을 메시지를 저장해 보세요.
            </p>
          </div>
        ) : (
          <ul className="list-none m-0 p-0">
            {items.map((item) => (
              <SavedItem
                key={item.id}
                item={item}
                onUnsave={(messageId) => toggle.mutate({ messageId, currentlySaved: true })}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
