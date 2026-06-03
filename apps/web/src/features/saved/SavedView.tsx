import { useState, type KeyboardEvent } from 'react';
import type { SaveStatus, SavedMessageDto } from '@qufox/shared-types';
import { SavedItem } from './SavedItem';
import { ReminderModal } from './ReminderModal';
import { useOverdueReminders, useSetReminder } from './useReminder';
import {
  useSavedCount,
  useSavedList,
  useToggleSave,
  useUpdateSavedStatus,
} from './useSavedMessages';

// S51 (D10 / FR-PS-07) + S52 (FR-PS-08): 개인 저장함 3탭 뷰. Slack Later 3탭(진행 중 /
// 보관 / 완료)에 1:1 대응한다. S52 부터 항목을 탭 간 이동(PATCH status)할 수 있어
// ARCHIVED/COMPLETED 탭도 채워진다. 항목별 액션은 SavedItem 의 완료 인라인 체크 +
// "⋯" 드롭다운에서 제공한다(탭별 가용 액션).
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
  const move = useUpdateSavedStatus();
  const setReminderMut = useSetReminder();
  // S53 (FR-PS-09): 리마인더 모달 대상 항목(null = 닫힘).
  const [reminderTarget, setReminderTarget] = useState<SavedMessageDto | null>(null);
  // S53 (FR-PS-11): 놓친 리마인더(재접속 동안 발화).
  const overdue = useOverdueReminders();
  const overdueCount = overdue.data?.items.length ?? 0;

  const items = list.data?.items ?? [];

  // S51 리뷰(a11y B-01): WAI-ARIA Tabs — ArrowLeft/Right 로 탭 이동(roving
  // tabindex). 패널 콘텐츠가 가벼워 selection-follows-focus 채택.
  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.id === active);
    const next =
      e.key === 'ArrowRight' ? (idx + 1) % TABS.length : (idx - 1 + TABS.length) % TABS.length;
    const nextId = TABS[next].id;
    setActive(nextId);
    e.currentTarget.querySelector<HTMLButtonElement>(`#saved-tab-${nextId}`)?.focus();
  }

  return (
    <section data-testid="saved-view" className="flex flex-col h-full">
      <header className="px-[var(--s-5)] pt-[var(--s-5)]">
        <h1
          className="m-0"
          style={{ font: '700 var(--fs-20) var(--font-sans)', color: 'var(--text-strong)' }}
        >
          저장됨
        </h1>
        <div className="qf-tabs mt-[var(--s-4)]" role="tablist" onKeyDown={onTabKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`saved-tab-${t.id}`}
              aria-selected={t.id === active}
              aria-controls={`saved-panel-${t.id}`}
              tabIndex={t.id === active ? 0 : -1}
              data-testid={`saved-tab-${t.id}`}
              onClick={() => setActive(t.id)}
              // S52 리뷰(a11y N-02): 카운트 배지는 aria-hidden 이므로 탭 접근명에
              // 개수를 실어 SR 이 "진행 중 (N)" 으로 듣게 한다.
              aria-label={
                t.id === 'IN_PROGRESS' && count.data && count.data.count > 0
                  ? `${t.label} (${count.data.count})`
                  : undefined
              }
              className="qf-tabs__item"
            >
              {t.label}
              {t.id === 'IN_PROGRESS' && count.data && count.data.count > 0 ? (
                <span className="qf-badge qf-badge--count ml-[var(--s-2)]" aria-hidden="true">
                  {count.data.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>

      <div
        role="tabpanel"
        id={`saved-panel-${active}`}
        aria-labelledby={`saved-tab-${active}`}
        data-testid={`saved-panel-${active}`}
        className="flex-1 overflow-y-auto px-[var(--s-5)] pb-[var(--s-5)]"
      >
        {overdueCount > 0 ? (
          <div
            data-testid="saved-overdue-banner"
            role="status"
            aria-live="polite"
            className="qf-banner qf-banner--info mb-[var(--s-3)]"
          >
            <span className="qf-banner__msg">놓친 리마인더가 {overdueCount}개 있습니다.</span>
          </div>
        ) : null}
        {list.isLoading ? (
          <p className="text-text-muted py-[var(--s-5)]">불러오는 중…</p>
        ) : items.length === 0 ? (
          <div className="qf-empty" role="status" aria-live="polite">
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
                onMove={(savedMessageId, from, to) => move.mutate({ savedMessageId, from, to })}
                onOpenReminder={(it) => setReminderTarget(it)}
              />
            ))}
          </ul>
        )}
      </div>

      {reminderTarget ? (
        <ReminderModal
          open={reminderTarget !== null}
          channelName={reminderTarget.channelName}
          hasReminder={(reminderTarget.reminderAt ?? null) !== null}
          onClose={() => setReminderTarget(null)}
          onSubmit={(reminderAt) =>
            setReminderMut.mutate({ savedMessageId: reminderTarget.id, reminderAt })
          }
        />
      ) : null}
    </section>
  );
}
